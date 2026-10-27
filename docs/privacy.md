# Privacy and data removal

Request Tracker saves the requests, choices and other records the agent writes for an enrolled conversation. It does not scrape your conversation history.

| Location | Contents |
| --- | --- |
| Local journal directory | Requests, cards, submitted replies, source references and change history. |
| Host webview storage | Unsent drafts and reply-delivery state. |
| Current AI conversation | Tool results and replies you submit. |

The default journal directory is `~/.request-journal/journals`. Set `REQUEST_JOURNAL_DATA_DIR` in the plugin process environment to choose another location.

Journal files are ordinary JSON, without application-level encryption. Access depends on your operating system and account permissions. Keep passwords, tokens and other secrets out of entries.

Request Tracker has no separate account, model API service or telemetry service. Your AI host processes conversation and tool data under its own settings and policies. Marking a notification as read updates the local journal through an app tool; it does not submit a chat reply.

## Stop tracking or remove data

Removing the plugin leaves journals in place. Back up or delete the journal directory separately when you no longer want the records. Removing journal files does not clear webview drafts or delivery state; use your host's storage controls for those. There is no combined delete-all-data command.

To stop tracking one conversation, tell the agent to stop and move that conversation's journal out of the active directory while it is not running. A saved journal enrolls the conversation for hooks, so a verbal request alone does not remove that enrollment. There is no permanent per-conversation opt-out switch; creating a journal again enables tracking again. Disabling the plugin affects every conversation using it.

## Local demo

The local demo uses fictional records and the production card renderer with a simulated host. It does not send replies to an agent. Demo drafts stay in memory and disappear on reload. Do not put real conversation data in screenshots, fixtures or bug reports.
