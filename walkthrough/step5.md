# Add Only the Capabilities You Need

Dline discovers reusable capabilities from explicit project and user locations instead of treating every integration as one global switch:

- rules, workflows, skills, named subagents, and MCP server toggles resolve through global, workspace, and task scopes;
- workspace MCP descriptors and configured remote servers remain independently selectable;
- browser, image, LSP, terminal, and other runtime tools use their own availability and approval controls rather than the same three-level scope model.

MCP configuration does not grant tool approval by itself. Requests still follow the active approval policy and safety boundaries.

[Open MCP Servers](command:dline.mcpButtonClicked) · [Read about capability scopes](https://docs.dline.cc/customization/capability-scopes/)
