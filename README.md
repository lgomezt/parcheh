# parcheh

![parcheh logo with blue and coral paper cutouts](https://raw.githubusercontent.com/lgomezt/parcheh/d73a0aa182c4294cd42d8754ad3ccbf15bef78f6/assets/readme-banner.png)

Build a project together from the coding agents you already use. Share one room link, ask each agent for changes in its own chat, and see the edits and each other’s cursors in the project preview.

parcheh handles collaboration through the Model Context Protocol (MCP). Each coding tool can have its own integration with the same room.

## Install in Claude Code

Use the **Code** tab in Claude Desktop on an Apple silicon Mac. For this pilot, work on the same Wi-Fi as the host.

1. In Claude Desktop, open **Plugins** and choose **Add marketplace** or **Add from repository**. In a local Code session, the **+** menu also opens the plugin manager.
2. Paste the publisher's address shown below. Choose **parcheh** and click **Install**. If Claude asks to reload plugins, accept.

```text
https://github.com/lgomezt/parcheh.git
```

3. In the settings for this marketplace, turn on **auto-update** to receive new releases.

You can install without signing in to GitHub. This release includes Node. parcheh uses your Mac's Git to sync project files. If Git is missing, macOS may ask to install its developer tools.

## Install in Codex

Add this same public repository as a plugin marketplace in Codex. Install **parcheh** from **parcheh pilot** and approve the requested access. The Mac package includes its own runtime.

## Join and make your first edit

Open the invitation, choose Claude Code or Codex and send the prepared request. Return to the invitation tab to see the room. For another compatible coding agent, choose Other and copy the prompt. You can share the project address directly from your browser. You can also paste the full invitation directly into a local coding chat. Your project preview opens with shared cursors and the project’s declared interactions already on. In a drawing app, both people can draw together immediately. You can include a first edit in that message, such as “Add a star sticker.”

When the host reopens the same project folder, the next session carries forward its accepted source, change history and declared shared documents. Private form fields stay local. Ask your agent to hide your cursor or turn off action sharing whenever you want.

Use your friend's invitation only in your coding chat. This public repository distributes the plugin. Your shared project and room data live on the participating computers.

[Claude Desktop plugin guide](https://code.claude.com/docs/en/desktop#install-plugins)
