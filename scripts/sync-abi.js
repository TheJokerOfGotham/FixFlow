// Recompiles FixFlow.sol and rewrites the ABI section of frontend/config.js
// (between the ABI-START / ABI-END markers). The address and chain ID are left untouched.
// Alternative: copy the ABI from Remix (Solidity Compiler tab -> "ABI" copy button).
const fs = require("fs");
const path = require("path");
const { compile } = require("./compile");

const configPath = path.join(__dirname, "..", "frontend", "config.js");
const abi = compile().FixFlow.abi;
const src = fs.readFileSync(configPath, "utf8");
const pattern = /(\/\/ ABI-START\n)[\s\S]*?(\n\s*\/\/ ABI-END)/;
if (!pattern.test(src)) throw new Error("ABI markers not found in frontend/config.js");
const body = "  CONTRACT_ABI: " + JSON.stringify(abi, null, 2).replace(/\n/g, "\n  ") + ",";
fs.writeFileSync(configPath, src.replace(pattern, `$1${body}$2`));
console.log(`Updated ABI in ${path.relative(process.cwd(), configPath)} (${abi.length} entries)`);
