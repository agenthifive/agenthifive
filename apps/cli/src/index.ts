#!/usr/bin/env node

import { Command } from "commander";
import { loginCommand } from "./commands/login.js";
import { connectCommand } from "./commands/connect.js";
import { connectionsCommand } from "./commands/connections.js";
import { executeCommand } from "./commands/execute.js";
import { auditCommand } from "./commands/audit.js";

const program = new Command();

program
  .name("ah5")
  .description("AgentHiFive CLI — manage connections, execute operations, and view audit logs")
  .version("0.1.0");

program.addCommand(loginCommand);
program.addCommand(connectCommand);
program.addCommand(connectionsCommand);
program.addCommand(executeCommand);
program.addCommand(auditCommand);

program.parse();
