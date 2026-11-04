# Crit for Herdr

This Herdr mod adds a Crit review inbox and a review composer.
It opens Crit in the system browser, not an embedded webview.

The local setup exercised Crit 0.23.2, Herdr 0.1.12, hc 0.1.17, and Node 26.13.0 on macOS.
The Crit session integration depends on the registry conventions of Crit 0.23.2.
Other versions are not validated. Linux is not validated. The browser-launch branch does not support Windows.

## Requirements

Install Crit, Node, Git, and Herdr's `hc` command on the local machine.
The selected agent must have a local terminal with an available working directory.
Remote spaces are not supported. Reviews run from the selected agent's working directory.
For GitHub pull requests, install and authenticate `gh` as required by Crit.
For GitLab merge requests, install and authenticate `glab` as required by Crit.
The panel also uses `glab` to list merge request choices.

The interface references icons from Herdr's `mods/workspace-chrome/` directory and `frame/settings/refresh.svg`.
The host installation must provide these assets. This repository does not include them.

## Install

Herdr loads this mod from its app home. The default is `~/.config/herdr-app`.
If you set `HERDR_APP_HOME`, use that directory as the app home.
The directory name `crit` is required because the interface uses that path to start the bridge.

1. Back up any existing `mods/crit` directory in your app home before replacing it.
2. Remove or move the existing directory after the backup. The clone command requires an absent destination.
3. Clone this repository into the app home:

   ```sh
   app_home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
   mkdir -p "$app_home/mods"
   git clone https://github.com/ederheisler/herdr-crit.git "$app_home/mods/crit"
   ```

4. Register the mod in a separate layout as described below.
5. Restart Herdr and select that layout.

## Register the layout

This repository does not include a complete Herdr layout.
Create a separate layout from your existing `main` layout in the app home's `layouts` directory.
For example, copy `main.json` to `main-crit.json`.
Back up an existing `main-crit.json` before replacing it.
Keep your own layout state and do not publish it with this mod.

In the clone, add this block to the `children` array of the `tabs-row` row:

```json
{
  "id": "crit-toolbar",
  "type": "block",
  "size": { "px": 76 },
  "content": { "mod": "crit", "props": { "toolbar": true } }
}
```

Add this block to the `children` array of the `panel-body` stack beside the `files` and `changes` blocks:

```json
{
  "id": "crit",
  "type": "block",
  "content": { "mod": "crit" }
}
```

The toolbar expects a panel with ID `panel` and a stack with ID `panel-body`.
The stack must contain the `crit` child. Preserve the rest of your layout.
Updates to `main` do not transfer to the clone. Select `main` in Herdr to use the stock layout.

## Start a review

1. Select `main-crit` in Herdr and open **Crit** beside **Files** and **Changes**.
2. Select **+** (tooltip: **New review**).
3. Open **Type**, choose a review type, and enter or select its target.
4. Use the agent chooser to select an agent from any space. Each entry shows the space and working folder for that agent. The selected folder remains visible outside the chooser.
5. Select **Start review** and complete the review in the browser.

The review types are:

- **Repository**: working changes, with an optional base branch under **Advanced**.
- **Files**: one path per line. Suggestions exclude selected files. Delete a line to remove its file.
- **Plan**: a plan file.
- **Live app**: an HTTP or HTTPS URL.
- **HTML preview**: an HTML file.
- **Pull request** and **Merge request**: a number or URL.
- **Commit range**: a range such as `base..head`.

This mod requires a Git working tree for **Repository**, **Commit range**, **Pull request**, and **Merge request**, including full request URLs and Story.
Those types appear only after the selected folder passes its Git check. Otherwise, **Type** shows only the four non-Git types below.
**Files**, **Plan**, **Live app**, and **HTML preview** do not require a Git working tree.

**Story** is available for repository reviews, pull requests, merge requests, and commit ranges.
The selected existing agent authors the Story. The mod does not launch another agent or use `agent_cmd`.

Focusing or editing a target opens suggestions automatically and filters them as you type, without moving keyboard focus. The mod waits 200 ms before loading choices. It reuses choices for the same agent, folder, and type.
Exact matches for typed targets take priority in the suggestions.
**Browse** opens the separate search field and refreshes the choices. Commit ranges also have **Choose base** and **Choose head** controls.

For **Files**, **Enter** completes the highlighted suggestion for the edited line. If choices are loading or no suggestion matches, Enter does not add a line. **Shift+Enter** adds a manual line break.
After choices finish loading, press **Enter** again to complete a file.

When you accept a file suggestion, press **Enter**, or start a review, the mod removes repeated entries. It preserves the first occurrence.

The input API does not expose the cursor position. The mod infers the edited file line or range side from text changes. Ambiguous file choices do not replace other entries. Complete ranges with an unclear side require **Choose base** or **Choose head**.

If a list cannot load in a valid working tree, a known target can be entered manually.
Bridge failure reasons remain visible in the panel.
Manual targets do not bypass the working-tree or forge CLI requirements.
Pull request choices and reviews require `gh`. Merge request choices and reviews require `glab`.
An unsupported `glab` JSON listing affects Browse only; a missing `glab` also prevents Crit from starting a merge request review.

## Inbox and review rounds

The inbox discovers existing local Crit sessions on its initial load.
Use the circular-arrow control (tooltip: **Refresh sessions**) to discover sessions started outside the panel after that load.
The inbox also refreshes its stored review list.
Each review shows its project or document title and status, then its assigned space, agent name, and terminal address, with direct action buttons below.
Indicators spin while preparing, starting, or applying feedback and use the Herdr working token.
Waiting and review-ready use theme ANSI yellow. Failures use blocked, approved uses done, and external or idle uses idle.
Hover for the exact phase.
Use **Open** to open its browser URL and **Agent** to show its assigned agent.
By default, **Open** uses the system browser. Optional Chrome integration can reuse a review tab.

Use **Close** to stop a review after confirmation. Cancel leaves it running.
Closing preserves source files and saved feedback; it does not approve the review, send new feedback, or interrupt its agent.
Select **Also close Chrome tab** to attempt browser-tab closure on macOS with Google Chrome and Automation access.
Otherwise, Close stops Crit and leaves the browser tab open.
If a launch is not yet identifiable or a handoff is in progress or uncertain, Close explains why it cannot safely proceed.

External reviews can be opened or closed but are not assigned to a Herdr agent. Finish them in Crit to submit feedback.
Each review started in the panel keeps its own selected agent for feedback. The mod has no agent-pinning feature or pinning step.
For Git reviews with untracked files, the mod asks that agent to prepare the intended files.
The agent uses `git add -N --` only on exact intended paths, not unrelated files or secrets.
If the task scope is unclear, the agent must ask rather than guess.
Git preparation can delay the browser until the agent completes its callback.

After a review finishes, the bridge sends the actual Crit feedback to its assigned agent.
For a live, idle agent, delivery uses `hc send --if idle`.
For a live agent in the Done state, the bridge checks its state again and sends without force.
The Done-state check and send are not atomic because `hc` 0.1.17 cannot guard on Done.
If the agent is working, blocked, unknown, or exited, delivery waits for **Retry** (tooltip: **Retry feedback handoff**).
If delivery fails, make the agent available and select **Retry**.
The stored handoff supports retry without rerunning the completed review.
If a handoff is interrupted with an unknown outcome, Close stays blocked until a successful Retry.
If the original agent terminal is gone, automatic recovery is unavailable. Check whether feedback was delivered before any manual record cleanup.
For requested changes, the agent addresses feedback and resumes the exact session and next round through the bridge.
For plans, the resume also uses the original revised plan file.
The final approved handoff gives the agent a complete command to close that exact managed review, not resume it.
Ordinary follow-up rounds do not regenerate the Story.

A durable waiter keeps each managed review attached to its Crit client.
If the bridge collector crashes, select **Reconnect** for the owned review.
Reconnect attaches to the same client and daemon without a new subscription, round, or agent.
It preserves feedback. The result waiter retires with the handoff.

The bridge rejects preexisting or ambiguous sessions that conflict with a managed launch.
Crit's API cannot exclude a truly simultaneous launch by another client.
Avoid starting a separate Crit review for the same scope at the same time.

## Chrome integration (macOS)

Open **Settings** to configure optional Google Chrome automation. Both preferences default to off for new users.
Opening settings checks existing access without prompting or launching Chrome.
Chrome must be running for this automatic check. **Start Chrome / request access** can open it.
**Save** closes settings after a successful save. A failed save leaves the dialog open.

The mod ignores background-only Chrome records and targets the main Chrome process by its process ID. If multiple main Chrome processes run, the mod does not choose one automatically.

- **Reuse review tabs in Chrome** selects an existing review tab instead of opening another.
- **Close Chrome tab by default** sets the initial choice of **Also close Chrome tab** in the Close confirmation.

The Close checkbox can override the saved preference for one review.
If Chrome automation fails, opening falls back to the system browser. Closing still stops Crit and warns if requested tab closure failed.
The access and **Automation settings** buttons share a row. The access button requests or rechecks permission. Its label reflects the current status. Enabling an option does not grant macOS permission.
If macOS does not prompt again, use **Automation settings**.
Enable the requesting app, usually Herdr, for Google Chrome under **Privacy & Security → Automation**. See [Apple's Automation guide](https://support.apple.com/guide/mac-help/allow-apps-to-automate-and-control-other-apps-mchl108e1718/mac).
On non-macOS systems, the Chrome options and access buttons are disabled.
Preferences stay in `data/crit/browser-settings.json` under the app home, not in the published mod folder.

## Local data and privacy

The mod stores records, pending handoffs, locks, and work files under `~/.config/herdr-app/data/crit/`.
If `HERDR_APP_HOME` is set, the data path is `$HERDR_APP_HOME/data/crit/` instead.
New private directories use mode `0700`. Records and handoff files use mode `0600`.
Handoff text and private request and result files under `work` use mode `0600`.
Crit output is embedded in result and pending JSON, not stored in separate stdout files.
These files persist on disk and can contain review feedback. Protect the local account and its backups.
The agent receives a path to the private handoff rather than its contents in the send command.
Discovery does not copy review tokens or review text into its external-session metadata.
Do not put tokens or credentials in review targets or URLs.

## Tests

Run the regression suite with Node 26.13.0:

```sh
npm test
```

The suite exercises the bridge through its public JSON command-line interface and the exported helper APIs.
It uses isolated temporary homes and test-owned process fixtures.
The permanent suite does not cover the `main.js` UI state machine, Git preparation, Story ingestion, or first-run process ownership.
Callback and ad hoc probes are not permanent suite coverage or native UI coverage.
It does not exercise Herdr's native keyboard handling or painting.
Check those behaviors manually in Herdr after a user interface change.

## License and decisions

This project is available under the [MIT license](LICENSE).
See the [third-party notices](THIRD_PARTY_NOTICES) for Crit.
The [project decisions](docs/decisions/README.md) record its public distribution and license choice.
