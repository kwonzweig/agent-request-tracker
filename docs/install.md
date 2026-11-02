# Install in Codex

## Requirements

- Git.
- Node.js 22 or later, with `node` and `npm` on the host's PATH.
- A Codex CLI with plugin commands. Check `codex --version` and `codex plugin list --help`; the local check requires `--json` and `--marketplace` support.
- A local Codex host with plugins and MCP Apps, including app-to-tool calls for **Mark as read**.
- Persistent webview storage and Web Locks for card replies. When these are unavailable, answer in chat.
- The [Humanizer skill](https://github.com/blader/humanizer#codex), which the tracker uses for human-facing prose. It is not bundled; check for an existing installation first.

## Try without installing

Clone the repository and run the demo from the checkout:

```sh
git clone https://github.com/kwonzweig/agent-request-tracker.git
cd agent-request-tracker
npm ci --ignore-scripts
npm run demo
```

Open the printed localhost URL. The demo uses fictional records and the production renderer with a simulated host. Nothing is installed in Codex, and no replies are sent to an agent.

## Build and add

```sh
git clone https://github.com/kwonzweig/agent-request-tracker.git
cd agent-request-tracker
npm ci --ignore-scripts
npm run check
codex plugin marketplace add .
codex plugin add request-tracker@request-tracker-local
node scripts/check-local-install.mjs
```

The build bundles the runtime dependencies into `plugin/`. Codex registers this checkout as a local marketplace and caches the plugin. Keep the checkout available for rebuilding and updates.

Open a conversation and invoke the skill:

```text
$request-tracker on
```

New conversations default OFF. ON remains saved for this conversation until you use `$request-tracker off`. OFF preserves your records; `$request-tracker on` resumes them. Natural-language ON/OFF requests also work. You do not need to repeat the instruction each turn.

Confirm that the tracker opens. Submit a harmless comment and check that it reaches the same conversation. Then try **Mark as read** on a Q&A, Note or Complete card; it should save without sending a message. See the [guide](guide.md) for the remaining actions.

Review the plugin's hooks in the host's supported controls before enabling them. In ON conversations they reload saved context and check the saved turn and its display request before the agent finishes. A missing update or display request can trigger one corrective continuation. Hooks do nothing while OFF. They cannot verify that work happened, that the host rendered the widget, or guarantee unattended continuation.

## Update or remove

From your checkout:

```sh
git pull --ff-only
npm ci --ignore-scripts
npm run check
codex plugin add request-tracker@request-tracker-local
node scripts/check-local-install.mjs
```

Repeated `plugin add` refreshes the local cache in the checked CLI. Confirm the preflight reports `checks_passed: true`. A cache update does not prove the running desktop loaded it; check the loaded version, and reload or restart the host if necessary when other work is finished.

To remove the plugin:

```sh
codex plugin remove request-tracker@request-tracker-local
```

Removal preserves saved data. See [privacy and data removal](privacy.md).

## Upgrade from the older plugin ID

If your installation uses `request-journal@request-journal-local`, finish active tracker work, update and build this checkout, then replace the old registration:

```sh
codex plugin remove request-journal@request-journal-local
codex plugin marketplace remove request-journal-local
codex plugin marketplace add .
codex plugin add request-tracker@request-tracker-local
node scripts/check-local-install.mjs
```

Saved data is preserved. The runtime reuses `~/.request-journal/journals` when it exists and `~/.request-tracker/journals` does not; it does not move live data. New installations use `~/.request-tracker/journals`. If both default directories exist, even if empty, select the intended directory with `REQUEST_TRACKER_DATA_DIR` before restarting instead of merging them automatically. Existing custom data overrides remain supported.

Reload the host after replacing the registration. The skill is now `$request-tracker`; use `$request-tracker on` or `$request-tracker off` in the conversation. A cache refresh alone does not establish that an already running host loaded the new skill.

## Check an isolated installation

To test packaging without changing your normal Codex installation, run this PowerShell block from the built checkout. It uses a new temporary Codex home and restores the environment afterward. It does not copy credentials or open a conversation.

```powershell
$previousCodexHome = $env:CODEX_HOME
$trialCodexHome = Join-Path ([IO.Path]::GetTempPath()) ("request-tracker-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $trialCodexHome | Out-Null
try {
    $env:CODEX_HOME = $trialCodexHome
    codex plugin marketplace add .
    if ($LASTEXITCODE -ne 0) { throw "Marketplace registration failed" }
    codex plugin add request-tracker@request-tracker-local
    if ($LASTEXITCODE -ne 0) { throw "Plugin installation failed" }
    node scripts/check-local-install.mjs
    if ($LASTEXITCODE -ne 0) { throw "Installation check failed" }
} finally {
    if ($null -eq $previousCodexHome) {
        Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue
    } else {
        $env:CODEX_HOME = $previousCodexHome
    }
    Write-Output "Temporary installation: $trialCodexHome"
}
```

Delete the printed temporary directory when finished. The preflight compares the built package with the installed cache, then probes a relocated package using isolated journal storage. It reads an empty journal and the UI resource; it does not submit replies or invoke write tools.

## Host limits

Local marketplace installation and cache refresh were checked on Windows with Codex CLI 0.142.5. Other clients may expose different plugin controls. A passing package check does not verify native rendering, message delivery, silent acknowledgments or hook continuation in your host. Test those actions in a disposable conversation before relying on them. Other agent apps are unverified.
