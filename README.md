# parcheh

![parcheh logo with blue and coral paper cutouts](https://raw.githubusercontent.com/lgomezt/parcheh/d73a0aa182c4294cd42d8754ad3ccbf15bef78f6/assets/readme-banner.png)

**Vibe code together, each with your own coding agent.**

Start with a new project or one you already have. Share one link, ask your own agents to make changes, and see each other’s edits and cursors in the same project preview.

[Install parcheh](#installation) in Codex, Claude Code, Antigravity, or another coding tool that supports local MCP servers.

## How to use it

1. Ask your coding agent to start a parcheh room with your project.
2. Copy the room link and share it with your collaborator.
3. Have your collaborator open the link and ask their own coding agent to join and make a first edit.

## Installation

These instructions are for Apple silicon Macs. Collaborators can join across different networks.

### Codex and Claude Code

Use this repository address for both apps.

```text
https://github.com/lgomezt/parcheh.git
```

- **Codex.** In **Plugins**, add the repository as a marketplace. Install **parcheh** from **parcheh pilot** and approve the requested access.
- **Claude Code.** In the **Code** tab of Claude Desktop, open **Plugins** and choose **Add marketplace** or **Add from repository**. Install **parcheh** and reload if prompted. Enable **auto-update** in the marketplace settings to receive new releases. [Claude Desktop plugin guide](https://code.claude.com/docs/en/desktop#install-plugins)

The plugin bundles Node.js and uses your Mac’s Git. macOS may ask you to install its command-line developer tools.

### Antigravity

Download `parcheh-antigravity-macos-arm64.zip` from the [latest release](https://github.com/lgomezt/parcheh/releases/latest) and unzip it. To install the skill and MCP server together, run `agy plugin install /full/path/to/parcheh` with the path to the extracted folder. If you only use Antigravity’s MCP settings, add the `parcheh` entry from `mcp_config.json` and replace `${PLUGIN_ROOT}` with that same path. Then open the invitation and choose **Antigravity**. [Antigravity plugin guide](https://antigravity.google/docs/cli/plugins)

### Other coding tools

Use a local coding tool that supports MCP servers over standard input and output (`stdio`) and can edit files in a local workspace. [Download this repository as a ZIP](https://github.com/lgomezt/parcheh/archive/refs/heads/main.zip), unzip it, and register `parcheh` in your app’s MCP settings using the command and arguments below.

- **Command** `/bin/sh`
- **Argument** The full path to `plugins/parcheh/launch-mcp.sh` in the extracted folder
- **Environment variables** `PARCHEH_DESKTOP=1`, `PARCHEH_ALLOW_LAN_HTTP=1`, and `PARCHEH_RELAY_ORIGIN=https://parcheh.augi.ca`

Open the invitation, choose **Other**, and paste the prepared prompt into your coding chat.
