// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title FixFlow - Maintenance requests with escrowed payments
 * @notice Tenants create and fund maintenance requests for authorized
 *         technicians. Funds stay in escrow until the tenant approves the
 *         work, a timeout rule applies, or an authorized arbitrator resolves
 *         a dispute.
 *
 * Escrow rules (all deterministic):
 *  - createRequest: tenant must send exactly `amount` wei (> 0).
 *  - Open      -> Cancelled : tenant cancels or technician declines; 100% to tenant.
 *  - Open/Accepted -> Refunded : deadline passed without completion; tenant claims 100%.
 *  - Completed -> Released  : tenant approves, OR review period elapsed and the
 *                             technician claims; 100% to technician.
 *  - Completed -> Disputed  : tenant disputes within the review period; funds frozen.
 *  - Disputed  -> Resolved  : arbitrator (not a party) picks one of:
 *                             FavorTechnician (100% tech), FavorTenant (100% tenant),
 *                             Split (50% tech, remainder to tenant).
 *                             If no arbitrator acts within the dispute timeout, either
 *                             party can apply DefaultSplit (same 50/50 split).
 *
 * Payouts use the pull-payment pattern: settlements credit `pendingWithdrawals`
 * and recipients call `withdraw()`. A recipient that cannot receive ETH can
 * therefore never block a settlement or corrupt the accounting.
 * The administrator manages roles only and has no way to move escrowed funds.
 */
contract FixFlow {
    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    enum Status {
        None,       // 0 - request does not exist
        Open,       // 1 - created and funded, awaiting technician acceptance
        Accepted,   // 2 - technician accepted the job
        Completed,  // 3 - technician marked the work as completed
        Disputed,   // 4 - tenant disputed the completed work
        Released,   // 5 - payment released to technician (final)
        Cancelled,  // 6 - cancelled before acceptance, tenant refunded (final)
        Refunded,   // 7 - deadline missed, tenant refunded (final)
        Resolved    // 8 - dispute resolved by arbitrator or timeout (final)
    }

    enum Resolution {
        None,            // 0
        FavorTechnician, // 1 - 100% to technician
        FavorTenant,     // 2 - 100% to tenant
        Split,           // 3 - 50% technician, remainder to tenant
        DefaultSplit     // 4 - dispute timed out, same split as `Split`
    }

    struct MaintenanceRequest {
        uint256 id;
        address tenant;
        address technician;
        uint256 amount;          // escrowed amount in wei
        uint64 deadline;         // completion deadline (unix seconds)
        uint64 createdAt;
        uint64 completedAt;
        uint64 disputedAt;
        Status status;
        Resolution resolution;
        address resolvedBy;      // arbitrator (or party that applied the default split)
        uint256 technicianPayout;
        uint256 tenantRefund;
        string description;
        string disputeReason;
    }

    struct HistoryEntry {
        Status status;
        address actor;
        uint64 timestamp;
    }

    // ------------------------------------------------------------------
    // Constants & configuration
    // ------------------------------------------------------------------

    uint256 public constant MAX_DESCRIPTION_LENGTH = 280;
    uint256 public constant MAX_REASON_LENGTH = 280;
    uint256 public constant MAX_DEADLINE_WINDOW = 365 days;

    /// @notice Seconds the tenant has to approve or dispute after completion.
    uint256 public immutable reviewPeriod;
    /// @notice Seconds an arbitrator has to resolve a dispute before the default split applies.
    uint256 public immutable disputeTimeout;

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    address public admin;
    mapping(address => bool) public isTechnician;
    mapping(address => bool) public isArbitrator;

    mapping(uint256 => MaintenanceRequest) private requests;
    mapping(uint256 => HistoryEntry[]) private histories;
    uint256[] private requestIds;

    /// @notice Settled amounts waiting to be withdrawn, per account.
    mapping(address => uint256) public pendingWithdrawals;
    /// @notice Sum of `amount` over all requests that are not yet settled.
    uint256 public totalEscrowed;
    /// @notice Sum of all `pendingWithdrawals`.
    uint256 public totalPendingWithdrawals;

    bool private locked;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event TechnicianAuthorized(address indexed account);
    event TechnicianRevoked(address indexed account);
    event ArbitratorAuthorized(address indexed account);
    event ArbitratorRevoked(address indexed account);

    event RequestCreated(uint256 indexed id, address indexed tenant, address indexed technician, uint256 amount, uint64 deadline);
    event RequestAccepted(uint256 indexed id, address indexed technician);
    event RequestDeclined(uint256 indexed id, address indexed technician);
    event RequestCancelled(uint256 indexed id, address indexed tenant);
    event WorkCompleted(uint256 indexed id, address indexed technician);
    event WorkApproved(uint256 indexed id, address indexed tenant);
    event DisputeRaised(uint256 indexed id, address indexed tenant, string reason);
    event DisputeResolved(uint256 indexed id, address indexed resolvedBy, Resolution resolution, uint256 technicianPayout, uint256 tenantRefund);
    event DeadlineRefund(uint256 indexed id, address indexed tenant);
    event ReviewPeriodPayout(uint256 indexed id, address indexed technician);

    event PaymentReleased(uint256 indexed id, address indexed technician, uint256 amount);
    event RefundIssued(uint256 indexed id, address indexed tenant, uint256 amount);
    event Withdrawal(address indexed account, uint256 amount);

    // ------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------

    // Modifier bodies delegate to private functions so the checks are not
    // inlined into every function (keeps the unoptimized bytecode under 24 KB).

    modifier onlyAdmin() {
        _checkAdmin();
        _;
    }

    modifier onlyArbitrator() {
        _checkArbitrator();
        _;
    }

    modifier requestExists(uint256 id) {
        _checkExists(id);
        _;
    }

    modifier onlyTenant(uint256 id) {
        _checkTenant(id);
        _;
    }

    modifier onlyAssignedTechnician(uint256 id) {
        _checkTechnician(id);
        _;
    }

    modifier inStatus(uint256 id, Status expected) {
        _checkStatus(id, expected);
        _;
    }

    modifier nonReentrant() {
        require(!locked, "FixFlow: reentrant call");
        locked = true;
        _;
        locked = false;
    }

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /**
     * @param _reviewPeriod   seconds the tenant has to approve/dispute (e.g. 300 for a demo, 259200 = 3 days)
     * @param _disputeTimeout seconds an arbitrator has before the default split applies
     */
    constructor(uint256 _reviewPeriod, uint256 _disputeTimeout) {
        require(_reviewPeriod > 0 && _reviewPeriod <= 30 days, "FixFlow: invalid review period");
        require(_disputeTimeout > 0 && _disputeTimeout <= 90 days, "FixFlow: invalid dispute timeout");
        admin = msg.sender;
        reviewPeriod = _reviewPeriod;
        disputeTimeout = _disputeTimeout;
        emit AdminTransferred(address(0), msg.sender);
    }

    // ------------------------------------------------------------------
    // Role management (admin only)
    // ------------------------------------------------------------------

    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "FixFlow: zero address");
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    function authorizeTechnician(address account) external onlyAdmin {
        require(account != address(0), "FixFlow: zero address");
        require(!isTechnician[account], "FixFlow: already a technician");
        isTechnician[account] = true;
        emit TechnicianAuthorized(account);
    }

    function revokeTechnician(address account) external onlyAdmin {
        require(isTechnician[account], "FixFlow: not a technician");
        isTechnician[account] = false;
        emit TechnicianRevoked(account);
    }

    function authorizeArbitrator(address account) external onlyAdmin {
        require(account != address(0), "FixFlow: zero address");
        require(!isArbitrator[account], "FixFlow: already an arbitrator");
        isArbitrator[account] = true;
        emit ArbitratorAuthorized(account);
    }

    function revokeArbitrator(address account) external onlyAdmin {
        require(isArbitrator[account], "FixFlow: not an arbitrator");
        isArbitrator[account] = false;
        emit ArbitratorRevoked(account);
    }

    // ------------------------------------------------------------------
    // Request lifecycle
    // ------------------------------------------------------------------

    /**
     * @notice Create and fund a maintenance request.
     * @param id          caller-chosen unique ID (> 0); duplicates revert
     * @param description short repair description (no personal data)
     * @param amount      agreed amount in wei; msg.value must equal it exactly
     * @param deadline    unix timestamp by which the work must be completed
     * @param technician  authorized technician assigned to the job
     */
    function createRequest(
        uint256 id,
        string calldata description,
        uint256 amount,
        uint64 deadline,
        address technician
    ) external payable {
        require(id != 0, "FixFlow: id must be non-zero");
        require(requests[id].status == Status.None, "FixFlow: request id already exists");
        uint256 descLength = bytes(description).length;
        require(descLength > 0 && descLength <= MAX_DESCRIPTION_LENGTH, "FixFlow: invalid description length");
        require(amount > 0, "FixFlow: amount must be greater than zero");
        require(msg.value == amount, "FixFlow: deposit must equal the agreed amount");
        require(deadline > block.timestamp, "FixFlow: deadline must be in the future");
        require(deadline <= block.timestamp + MAX_DEADLINE_WINDOW, "FixFlow: deadline too far in the future");
        require(isTechnician[technician], "FixFlow: technician is not authorized");
        require(technician != msg.sender, "FixFlow: tenant cannot be the technician");

        MaintenanceRequest storage r = requests[id];
        r.id = id;
        r.tenant = msg.sender;
        r.technician = technician;
        r.amount = amount;
        r.deadline = deadline;
        r.createdAt = uint64(block.timestamp);
        r.description = description;

        requestIds.push(id);
        totalEscrowed += amount;
        _setStatus(id, Status.Open);

        emit RequestCreated(id, msg.sender, technician, amount, deadline);
    }

    /// @notice Assigned technician accepts the job before the deadline.
    function acceptRequest(uint256 id)
        external
        requestExists(id)
        onlyAssignedTechnician(id)
        inStatus(id, Status.Open)
    {
        require(isTechnician[msg.sender], "FixFlow: technician authorization revoked");
        require(block.timestamp <= requests[id].deadline, "FixFlow: deadline has passed");
        _setStatus(id, Status.Accepted);
        emit RequestAccepted(id, msg.sender);
    }

    /// @notice Assigned technician declines an open job; tenant is refunded in full.
    function declineRequest(uint256 id)
        external
        requestExists(id)
        onlyAssignedTechnician(id)
        inStatus(id, Status.Open)
    {
        _setStatus(id, Status.Cancelled);
        _refundTenantFully(id);
        emit RequestDeclined(id, msg.sender);
    }

    /// @notice Tenant cancels a job that has not been accepted yet; full refund.
    function cancelRequest(uint256 id)
        external
        requestExists(id)
        onlyTenant(id)
        inStatus(id, Status.Open)
    {
        _setStatus(id, Status.Cancelled);
        _refundTenantFully(id);
        emit RequestCancelled(id, msg.sender);
    }

    /// @notice Assigned technician marks accepted work as completed (before the deadline).
    function markCompleted(uint256 id)
        external
        requestExists(id)
        onlyAssignedTechnician(id)
        inStatus(id, Status.Accepted)
    {
        require(block.timestamp <= requests[id].deadline, "FixFlow: deadline has passed");
        requests[id].completedAt = uint64(block.timestamp);
        _setStatus(id, Status.Completed);
        emit WorkCompleted(id, msg.sender);
    }

    /// @notice Tenant approves completed work; escrow is released to the technician.
    function approveWork(uint256 id)
        external
        requestExists(id)
        onlyTenant(id)
        inStatus(id, Status.Completed)
    {
        _setStatus(id, Status.Released);
        _releaseToTechnician(id);
        emit WorkApproved(id, msg.sender);
    }

    /// @notice Tenant disputes completed work within the review period; funds stay frozen.
    function raiseDispute(uint256 id, string calldata reason)
        external
        requestExists(id)
        onlyTenant(id)
        inStatus(id, Status.Completed)
    {
        uint256 reasonLength = bytes(reason).length;
        require(reasonLength > 0 && reasonLength <= MAX_REASON_LENGTH, "FixFlow: invalid reason length");
        require(block.timestamp <= requests[id].completedAt + reviewPeriod, "FixFlow: review period has ended");
        MaintenanceRequest storage r = requests[id];
        r.disputeReason = reason;
        r.disputedAt = uint64(block.timestamp);
        _setStatus(id, Status.Disputed);
        emit DisputeRaised(id, msg.sender, reason);
    }

    /**
     * @notice Authorized arbitrator settles a dispute using one of the predefined outcomes.
     * @param outcome FavorTechnician (1), FavorTenant (2) or Split (3)
     */
    function resolveDispute(uint256 id, Resolution outcome)
        external
        onlyArbitrator
        requestExists(id)
        inStatus(id, Status.Disputed)
    {
        MaintenanceRequest storage r = requests[id];
        require(msg.sender != r.tenant && msg.sender != r.technician, "FixFlow: arbitrator is a party to this request");
        require(
            outcome == Resolution.FavorTechnician || outcome == Resolution.FavorTenant || outcome == Resolution.Split,
            "FixFlow: invalid resolution"
        );
        _settleDispute(id, outcome);
    }

    // ------------------------------------------------------------------
    // Timeout paths (no funds can be locked forever)
    // ------------------------------------------------------------------

    /// @notice Tenant reclaims escrow when the deadline passed without completed work.
    function claimRefundAfterDeadline(uint256 id)
        external
        requestExists(id)
        onlyTenant(id)
    {
        Status s = requests[id].status;
        require(s == Status.Open || s == Status.Accepted, "FixFlow: invalid request status");
        require(block.timestamp > requests[id].deadline, "FixFlow: deadline has not passed");
        _setStatus(id, Status.Refunded);
        _refundTenantFully(id);
        emit DeadlineRefund(id, msg.sender);
    }

    /// @notice Technician claims payment when the tenant neither approved nor disputed in time.
    function claimPaymentAfterReview(uint256 id)
        external
        requestExists(id)
        onlyAssignedTechnician(id)
        inStatus(id, Status.Completed)
    {
        require(block.timestamp > requests[id].completedAt + reviewPeriod, "FixFlow: review period not over");
        _setStatus(id, Status.Released);
        _releaseToTechnician(id);
        emit ReviewPeriodPayout(id, msg.sender);
    }

    /// @notice Either party applies the default 50/50 split when no arbitrator acted in time.
    function resolveExpiredDispute(uint256 id)
        external
        requestExists(id)
        inStatus(id, Status.Disputed)
    {
        MaintenanceRequest storage r = requests[id];
        require(msg.sender == r.tenant || msg.sender == r.technician, "FixFlow: caller is not a party to this request");
        require(block.timestamp > r.disputedAt + disputeTimeout, "FixFlow: dispute timeout not reached");
        _settleDispute(id, Resolution.DefaultSplit);
    }

    // ------------------------------------------------------------------
    // Withdrawals (pull payments)
    // ------------------------------------------------------------------

    /// @notice Withdraw all settled funds credited to the caller.
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "FixFlow: nothing to withdraw");

        // Effects before interaction
        pendingWithdrawals[msg.sender] = 0;
        totalPendingWithdrawals -= amount;

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "FixFlow: ETH transfer failed");
        emit Withdrawal(msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function getRequest(uint256 id) external view requestExists(id) returns (MaintenanceRequest memory) {
        return requests[id];
    }

    function getHistory(uint256 id) external view requestExists(id) returns (HistoryEntry[] memory) {
        return histories[id];
    }

    function requestExistsById(uint256 id) external view returns (bool) {
        return requests[id].status != Status.None;
    }

    function getRequestCount() external view returns (uint256) {
        return requestIds.length;
    }

    function getAllRequestIds() external view returns (uint256[] memory) {
        return requestIds;
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    function _checkAdmin() private view {
        require(msg.sender == admin, "FixFlow: caller is not the admin");
    }

    function _checkArbitrator() private view {
        require(isArbitrator[msg.sender], "FixFlow: caller is not an arbitrator");
    }

    function _checkExists(uint256 id) private view {
        require(requests[id].status != Status.None, "FixFlow: request does not exist");
    }

    function _checkTenant(uint256 id) private view {
        require(msg.sender == requests[id].tenant, "FixFlow: caller is not the tenant");
    }

    function _checkTechnician(uint256 id) private view {
        require(msg.sender == requests[id].technician, "FixFlow: caller is not the assigned technician");
    }

    function _checkStatus(uint256 id, Status expected) private view {
        require(requests[id].status == expected, "FixFlow: invalid request status");
    }

    function _setStatus(uint256 id, Status newStatus) private {
        requests[id].status = newStatus;
        histories[id].push(HistoryEntry(newStatus, msg.sender, uint64(block.timestamp)));
    }

    function _refundTenantFully(uint256 id) private {
        MaintenanceRequest storage r = requests[id];
        r.tenantRefund = r.amount;
        _settle(r.amount);
        _credit(r.tenant, r.amount);
        emit RefundIssued(id, r.tenant, r.amount);
    }

    function _releaseToTechnician(uint256 id) private {
        MaintenanceRequest storage r = requests[id];
        r.technicianPayout = r.amount;
        _settle(r.amount);
        _credit(r.technician, r.amount);
        emit PaymentReleased(id, r.technician, r.amount);
    }

    function _settleDispute(uint256 id, Resolution outcome) private {
        MaintenanceRequest storage r = requests[id];
        uint256 techShare;
        if (outcome == Resolution.FavorTechnician) {
            techShare = r.amount;
        } else if (outcome == Resolution.FavorTenant) {
            techShare = 0;
        } else {
            techShare = r.amount / 2; // odd wei goes to the tenant
        }
        uint256 tenantShare = r.amount - techShare;

        r.resolution = outcome;
        r.resolvedBy = msg.sender;
        r.technicianPayout = techShare;
        r.tenantRefund = tenantShare;
        _setStatus(id, Status.Resolved);
        _settle(r.amount);

        if (techShare > 0) {
            _credit(r.technician, techShare);
            emit PaymentReleased(id, r.technician, techShare);
        }
        if (tenantShare > 0) {
            _credit(r.tenant, tenantShare);
            emit RefundIssued(id, r.tenant, tenantShare);
        }
        emit DisputeResolved(id, msg.sender, outcome, techShare, tenantShare);
    }

    function _settle(uint256 amount) private {
        totalEscrowed -= amount;
    }

    function _credit(address account, uint256 amount) private {
        pendingWithdrawals[account] += amount;
        totalPendingWithdrawals += amount;
    }
}
