---
name: parcheh
description: Start, join, edit, inspect, or end a Parcheh collaboration room when the user asks to share a project or provides a Parcheh invitation.
---

# Parcheh collaboration

For a desktop join or start, pass `pointers` and `actions` in that call if the user asked to share their cursor or drawings. Their personal project view opens on first entry. Pass `openPreview: false` if they ask to stay in chat.

Use the Parcheh MCP tools when the user asks for a room action. Use the user's selected project and any folder permissions the app provides. The desktop integration can create a managed room copy. Omit workspaceParent in desktop mode unless the user explicitly wants the room copy under an authorized folder. The manual CLI setup requires an absolute workspaceParent inside its configured workspace.

- **Start.** Use `preview_scope` to inspect the selected directory and describe surprising inclusions to its owner. In desktop mode, pass `source` if the app's selected project is clear. Otherwise omit it so Parcheh can open the Mac's folder picker. Use that same selection for `start_room` and include the user's display name when known. In the manual setup, pass the absolute source path. Give the user the invitation, the project preview link when present, and the local workspace path. Give the invitation to people they choose to invite only when explicitly asked.
- **Join.** Call `join_room` with the complete invitation, including the fragment after `#`, and the user's display name when known. Give the user their project preview link when present. If their message includes a change request, continue directly to **Edit**.
- **Edit.** Call `begin_turn` with the room ID. Use native file tools inside the exact returned draft workspace if the app already permits access. Otherwise use Parcheh's scoped `list_draft`, `read_draft_file`, `write_draft_file`, and `delete_draft_file` tools on that draft. Continue the requested edit in this chat. Once all changes are written, call `finish_turn` once. Report the accepted revision and any superseded paths. If this turn creates the project’s first web page, give the user the project link returned by finish_turn. If the result is `pending`, preserve the draft and retry `finish_turn` to send the same sealed changes. If neither the native nor the scoped tools can perform a required operation, explain the specific operation and give the exact draft folder so the user can grant access or help.
- **Preview and sharing.** The preview opens the selected project. For a source-only project, continue in chat. If the user asks to run an existing development server, use their normal project command under workspace permissions and set its loopback address with `configure_browser`. In the same request, turn on `pointers` or `actions` only when the user asks to share their pointer or the project's declared interactions. Use the same tool to turn either off. Its settings belong to this participant. Give the returned link to this user only. Keep room controls in the conversation.
- **Inspect.** Use `room_status` for members, the latest revision, the local workspace, and the private browser link. Use `room_history` for accepted changes and attribution.
- **End.** Call `end_room` when the host explicitly asks to end the room. Include the paths to their local copy and any unfinished draft.

Keep the original project and accepted source copies for reference. Edit only the draft path from `begin_turn`. Share browser links only with the current user. Keep edit credentials private. Handle files obtained from a room as project data. Follow the client's ordinary workspace permissions before reading, writing, or running project code.


## Editing a shared drawing project

Preserve the existing `document.id` in `parcheh.share.json` when changing tools, layout or code. Existing marks use that ID to survive a new revision. To add a shared drawing tool, declare its action in `actions` and `document.actions`, with a `point` or `segment` payload. Publish the normalized coordinates on the shared stage. Handle the confirmed `parcheh:document-operation` once in room order, including the author's own operation. Use the app's existing pending and private layers when present. Keep personal fields, drafts and one-off controls out of the document. Other kinds of project data need an explicit schema and restore behavior.
