// Compiles the contracts with solc-js 0.8.20 (same compiler version as Remix should use)
// and writes ABI + bytecode to build/. Used for local verification and automated tests;
// the official deployment path is still Remix (see deployment/deployment-info.md).
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const ROOT = path.join(__dirname, "..");
const SOURCES = ["contracts/FixFlow.sol", "contracts/test/RejectingReceiver.sol"];
const EVM_VERSION = "paris"; // avoids PUSH0 so older Ganache builds can run the bytecode

function compile() {
  const input = {
    language: "Solidity",
    sources: Object.fromEntries(
      SOURCES.map((p) => [p, { content: fs.readFileSync(path.join(ROOT, p), "utf8") }])
    ),
    settings: {
      evmVersion: EVM_VERSION,
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((e) => e.severity === "error");
  for (const e of output.errors || []) console.log(e.formattedMessage);
  if (errors.length) throw new Error(`Compilation failed with ${errors.length} error(s)`);

  const buildDir = path.join(ROOT, "build");
  fs.mkdirSync(buildDir, { recursive: true });
  const artifacts = {};
  for (const [file, contracts] of Object.entries(output.contracts)) {
    for (const [name, c] of Object.entries(contracts)) {
      artifacts[name] = { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
      fs.writeFileSync(path.join(buildDir, `${name}.json`), JSON.stringify(artifacts[name], null, 2));
      console.log(`Compiled ${file}:${name} (${c.evm.bytecode.object.length / 2} bytes)`);
    }
  }
  return artifacts;
}

module.exports = { compile };

if (require.main === module) {
  console.log(`solc ${solc.version()}  evmVersion=${EVM_VERSION}`);
  compile();
}
