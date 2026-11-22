# parcheh

Build a project together from the coding agents you already use. Share one room link, ask each agent for changes in its own chat, and see the edits and each other’s cursors in the project preview.

parcheh handles collaboration through the Model Context Protocol (MCP). Each coding tool can have its own integration with the same room.

## Install in Claude Code

The public installer currently supports the **Code** tab in Claude Desktop on Apple silicon Macs. For this pilot, work on the same Wi-Fi as the host.

1. In Claude Desktop, open **Plugins** and choose **Add marketplace** or **Add from repository**. In a local Code session, the **+** menu also opens the plugin manager.
2. Paste the publisher's address shown below. Choose **parcheh** and click **Install**. If Claude asks to reload plugins, accept.

```text
https://github.com/lgomezt/parcheh.git
```

3. In the settings for this marketplace, turn on **auto-update** to receive new releases.

You can install without signing in to GitHub. This release includes Node. parcheh uses your Mac's Git to sync project files. If Git is missing, macOS may ask to install its developer tools.

## Join and make your first edit

In a local Code chat, paste the full invitation and say “Join this room.” Your project preview opens with shared cursors and the project’s declared interactions already on. In a drawing app, both people can draw together immediately. You can include a first edit in that message, such as “Add a star sticker.”

Private form fields stay local. Ask your agent to hide your cursor or turn off action sharing whenever you want.

Use your friend's invitation only in your coding chat. This public repository distributes the plugin. Your shared project and room data live on the participating computers.

[Claude Desktop plugin guide](https://code.claude.com/docs/en/desktop#install-plugins)
