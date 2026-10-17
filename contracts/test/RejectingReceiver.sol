// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title RejectingReceiver (TEST HELPER ONLY - do not deploy for the demo)
 * @notice Acts as a tenant that refuses incoming ETH, or that tries to re-enter
 *         `withdraw()`. Used to verify that failed or malicious payouts do not
 *         corrupt FixFlow's escrow accounting.
 */
interface IFixFlow {
    function createRequest(uint256 id, string calldata description, uint256 amount, uint64 deadline, address technician) external payable;
    function cancelRequest(uint256 id) external;
    function withdraw() external;
}

contract RejectingReceiver {
    IFixFlow public immutable fixflow;
    bool public acceptPayments;
    bool public reenter;

    constructor(address _fixflow) {
        fixflow = IFixFlow(_fixflow);
    }

    function setMode(bool _acceptPayments, bool _reenter) external {
        acceptPayments = _acceptPayments;
        reenter = _reenter;
    }

    function create(uint256 id, uint64 deadline, address technician) external payable {
        fixflow.createRequest{value: msg.value}(id, "test request", msg.value, deadline, technician);
    }

    function cancel(uint256 id) external {
        fixflow.cancelRequest(id);
    }

    function pull() external {
        fixflow.withdraw();
    }

    receive() external payable {
        require(acceptPayments, "RejectingReceiver: payments refused");
        if (reenter) {
            fixflow.withdraw(); // must fail because of the reentrancy guard
        }
    }
}
