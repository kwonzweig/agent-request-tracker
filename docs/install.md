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
codex plugin add request-journal@request-journal-local
node scripts/check-local-install.mjs
```

The build bundles the runtime dependencies into `plugin/`. Codex registers this checkout as a local marketplace and caches the plugin. Keep the checkout available for rebuilding and updates.

The product is Request Tracker. Its plugin ID and storage names remain `request-journal` for compatibility with existing installations.

Open a conversation and ask:

> Use Request Tracker in this conversation. Track my requests and unresolved choices.

Confirm that the tracker opens. Submit a harmless comment and check that it reaches the same conversation. Then try **Mark as read** on a Q&A, Note or Complete card; it should save without sending a message. See the [guide](guide.md) for the remaining actions.

Review the plugin's hooks in the host's supported controls before enabling them. They reload saved context and check the agent's stated reason for stopping. They cannot verify that work happened or guarantee unattended continuation.

## Update or remove

From your checkout:

```sh
git pull --ff-only
npm ci --ignore-scripts
npm run check
codex plugin add request-journal@request-journal-local
node scripts/check-local-install.mjs
```

Repeated `plugin add` refreshes the local cache in the checked CLI. Confirm the preflight reports `checks_passed: true`. A cache update does not prove the running desktop loaded it; check the loaded version, and reload or restart the host if necessary when other work is finished.

To remove the plugin:

```sh
codex plugin remove request-journal@request-journal-local
```

Removal preserves saved data. See [privacy and data removal](privacy.md).

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
    codex plugin add request-journal@request-journal-local
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
