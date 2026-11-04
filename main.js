import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Checkbox } from "gpui-base";
import { agents, appHome, closeOverlay, exec, focused, layout, nextCommand, notify, openOverlay, panes, props, run, setShared, shared, spaces, theme } from "herdr";

const MODES = [
  { id: "git", label: "Repository", field: "Base branch (optional)", placeholder: "Default branch" },
  { id: "files", label: "Files", field: "Files to review", placeholder: "One path per line" },
  { id: "plan", label: "Plan", field: "Plan file", placeholder: "Path to plan" },
  { id: "live", label: "Live app", field: "Live URL", placeholder: "http://localhost:3000" },
  { id: "preview", label: "HTML preview", field: "HTML file", placeholder: "Path to HTML file" },
  { id: "pr", label: "Pull request", field: "Pull request", placeholder: "Number or URL" },
  { id: "mr", label: "Merge request", field: "Merge request", placeholder: "Number or URL" },
  { id: "range", label: "Commit range", field: "Commit range", placeholder: "base..head" },
];
const STORY = ["git", "pr", "mr", "range"];
const GIT_MODES = ["git", "range", "pr", "mr"];
const NON_GIT_MODES = MODES.filter((mode) => !GIT_MODES.includes(mode.id));
const PHASES = {
  preparing_git: "Preparing files",
  preparing_story: "Preparing Story",
  starting: "Starting",
  reviewing: "In review",
  feedback_pending: "Handoff failed",
  agent_working: "Applying feedback",
  approved: "Approved",
  external: "External",
  error: "Needs attention",
};

function uniqueFileLines(value) {
  const seen = new Set();
  return value.split("\n").filter((line) => {
    const file = line.replace(/\r$/, "");
    if (!file) return true;
    if (seen.has(file)) return false;
    seen.add(file);
    return true;
  }).join("\n");
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function agentLabel(agent) {
  return agent?.title || agent?.program?.name || agent?.app || "Agent";
}

function folderName(value) {
  const path = typeof value === "string" ? value : "";
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path || "Review";
}

function reviewTitle(review) {
  const target = typeof review.target === "string" ? review.target : "";
  if (review.mode === "plan" || review.mode === "preview") return target ? folderName(target) : folderName(review.cwd);
  if (review.mode === "files") {
    const files = target.split(/\r?\n/).filter(Boolean);
    if (files.length) return folderName(files[0]) + (files.length > 1 ? ` + ${files.length - 1}` : "");
  }
  return folderName(review.cwd);
}

export default class Crit extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    if (props()?.closeReview || props()?.settings) {
      this.settingsLoading = true;
      this.accessStatus = "checking";
      this.accessMessage = "";
      this.overlayId = props().overlay;
      this.isSettingsOverlay = Boolean(props()?.settings);
      this.handle.focus();
      cx.spawn(async (cx) => {
        try {
          this.browserSettings = await this.bridge("settings");
          this.reuseChromeTabs = this.browserSettings.reuseChromeTabs;
          this.closeChromeTabs = this.browserSettings.closeChromeTabs;
          if (props()?.settings) {
            cx.notify();
            try { this.setAccess(await this.bridge("chrome-access", "--check")); }
            catch (error) { this.accessStatus = "error"; this.accessMessage = error.message || "Could not check access."; }
          }
        } catch (error) { this.accessStatus = "error"; this.message = error?.message || "Could not load browser settings. Close and try again."; }
        finally { this.settingsLoading = false; cx.notify(); }
      });
      return;
    }
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") { this.handle.focus(); cx.notify(); }
        if (command === "settings") this.openSettings();
        if (command === "refresh" && !props()?.toolbar) {
          const notice = shared("crit.closeNotice");
          if (notice) { this.message = notice; setShared("crit.closeNotice", null); }
          this.refresh(cx);
        }
      }
    });
    if (props()?.toolbar) {
      const value = shared("workspace.panels");
      const enabled = Array.isArray(value) ? value : ["files", "changes"];
      if (!enabled.includes("crit")) setShared("workspace.panels", [...enabled, "crit"]);
      return;
    }

    cx.bind_keys([
      { keystroke: "enter", action: "crit_files_complete", context: "CritFilesInput > Input" },
      { keystroke: "up", action: "crit_files_previous", context: "CritFilesInput > Input" },
      { keystroke: "down", action: "crit_files_next", context: "CritFilesInput > Input" },
      ...[
        "left", "right", "home", "end", "pageup", "pagedown",
        "shift-left", "shift-right", "shift-up", "shift-down", "shift-home", "shift-end",
        "cmd-a", "ctrl-a", "ctrl-e", "ctrl-shift-a", "ctrl-shift-e",
        "cmd-left", "cmd-right", "cmd-up", "cmd-down",
        "shift-cmd-left", "shift-cmd-right", "cmd-shift-up", "cmd-shift-down",
        "alt-left", "alt-right", "alt-shift-left", "alt-shift-right",
        "ctrl-left", "ctrl-right", "ctrl-shift-left", "ctrl-shift-right",
        "ctrl-home", "ctrl-end", "ctrl-shift-home", "ctrl-shift-end",
        "cmd-alt-up", "cmd-alt-down", "ctrl-alt-up", "ctrl-alt-down", "shift-alt-up", "shift-alt-down",
      ].map((keystroke) => ({ keystroke, action: "crit_files_cursor_move", context: "CritFilesInput > Input" })),
    ]);

    this.mode = "files";
    this.story = false;
    this.modeFocus = cx.focus_handle();
    this.modeListFocus = cx.focus_handle();
    this.modeOpen = false;
    this.modeAt = 0;
    this.candidatePicker = null;
    this.candidateOptions = [];
    this.candidateCache = null;
    this.candidateRequest = null;
    this.candidateTimer = null;
    this.candidatePending = null;
    this.candidateSequence = 0;
    this.candidateEpoch = 0;
    this.targetFocus = null;
    this.candidateSearch = InputState.new({ placeholder: "Search" });
    this.candidateSearch.on("change", (_e, cx) => { this.candidateAt = 0; cx.notify(); });
    this.candidateSearch.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.candidateSearch.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.candidateSearch.on("submit", (_e, cx) => {
      const option = this.matchingCandidates()[this.candidateAt];
      if (option) this.chooseCandidate(option, cx);
    });
    this.inputs = {};
    this.inputValues = {};
    for (const mode of MODES) {
      const input = mode.id === "files"
        ? TextareaState.new({ placeholder: mode.placeholder, rows: 3 })
        : InputState.new({ placeholder: mode.placeholder });
      this.inputs[mode.id] = input;
      this.inputValues[mode.id] = input.value();
      input.on("change", (_e, cx) => {
        const previous = this.inputValues[mode.id];
        const value = input.value();
        this.inputValues[mode.id] = value;
        this.message = null;
        if (value !== previous && this.targetFocus === mode.id) this.autocomplete(mode.id, previous, cx);
        cx.notify();
      });
      input.on("focus", (_e, cx) => {
        this.targetFocus = mode.id;
        this.typing = true;
        this.autocomplete(mode.id, null, cx);
        cx.notify();
      });
      input.on("blur", (_e, cx) => {
        if (this.targetFocus === mode.id) {
          this.targetFocus = null;
          if (!this.candidatePicker?.manual) this.cancelCandidateTimer();
        }
        this.typing = false;
        cx.notify();
      });
      if (mode.id !== "files") input.on("submit", (_e, cx) => {
        if (this.targetFocus !== mode.id || !this.candidatePicker || this.candidatePicker.manual) return;
        const option = this.matchingCandidates()[this.candidateAt];
        if (option) this.chooseCandidate(option, cx);
      });
    }
    this.reviews = [];
    this.composing = false;
    this.firstLoad = true;
    this.loading = true;
    cx.spawn(async (cx) => {
      try { await this.bridge("discover"); }
      catch { this.message = "Could not refresh sessions. Try again."; }
      finally {
        this.loading = false;
        this.refreshAgain = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  async bridge(verb, ...args) {
    const result = await exec("node", [`${appHome()}/mods/crit/bridge.mjs`, verb, ...args]);
    let data;
    try { data = JSON.parse(result.stdout || "{}"); }
    catch { throw new Error(result.stderr || "Crit bridge returned an invalid response."); }
    if (result.code !== 0 || data.error) throw new Error(data.error || result.stderr || "Crit bridge failed.");
    return data;
  }

  refresh(cx) {
    if (this.loading) { this.refreshAgain = true; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const data = await this.bridge("list");
        const reviews = Array.isArray(data.reviews) ? data.reviews : [];
        if (!this.firstLoad) {
          const previous = new Map(this.reviews.map((review) => [review.id, review]));
          let notified = shared("crit.readyNotifications");
          if (!notified || typeof notified !== "object" || Array.isArray(notified)) notified = {};
          for (const review of reviews) {
            const old = previous.get(review.id);
            if (review.notice && review.notice !== old?.notice) this.message = review.notice;
            if (review.phase !== "reviewing" || (old?.phase === "reviewing" && old.round === review.round)) continue;
            const token = `${review.phase}:${review.round ?? review.updatedAt ?? ""}`;
            if (notified[review.id] === token) continue;
            notified = { ...notified, [review.id]: token };
            setShared("crit.readyNotifications", notified);
            const mode = MODES.find((item) => item.id === review.mode)?.label || review.mode;
            notify({
              title: "Crit review ready",
              body: `${mode}${review.story ? " + Story" : ""} · ${review.cwd}`,
              action: { name: "agent.focus", args: { terminal: review.agentAddress } },
            });
          }
        }
        this.reviews = reviews;
        this.listError = null;
        this.firstLoad = false;
      } catch { this.listError = "Try refreshing sessions."; }
      finally {
        this.loading = false;
        if (this.refreshAgain) { this.refreshAgain = false; this.refresh(cx); }
        cx.notify();
      }
    });
  }

  action(verb, args, cx) {
    if (this.busy) return;
    const closeOverlayId = props()?.closeReview ? props().overlay : null;
    this.busy = verb;
    this.message = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const data = await this.bridge(verb, ...args);
        if (data.notice && !closeOverlayId) this.message = data.notice;
        if (verb === "close" && closeOverlayId) {
          if (data.notice) setShared("crit.closeNotice", data.notice);
          closeOverlay(closeOverlayId);
          run("crit.refresh");
        } else if (verb === "start") {
          this.composing = false;
          this.invalidateCandidates(true);
        }
      } catch (error) {
        this.message = error?.message || ({
          start: "Could not start the review. Check the target and agent.",
          open: "Could not open the review. Try again.",
          discover: "Could not refresh sessions. Try again.",
          deliver: "Could not hand feedback to the agent. Try again.",
          reconnect: "Could not reconnect. Check the review in Crit.",
          close: "Could not close the review. Refresh sessions and try again.",
        })[verb] || "Action failed. Try again.";
      }
      finally { this.busy = null; if (!closeOverlayId) this.refresh(cx); cx.notify(); }
    });
  }
  async close() {
    if (this.inputs) this.invalidateCandidates(true);
    if (this.isSettingsOverlay && shared("crit.settingsOverlay") === this.overlayId) setShared("crit.settingsOverlay", null);
  }

  openSettings() {
    const previous = shared("crit.settingsOverlay");
    if (typeof previous === "string" && previous) closeOverlay(previous);
    const id = openOverlay({
      mod: "crit", kind: "dialog", modal: true, width: 500, height: 470,
      props: { settings: true },
    });
    setShared("crit.settingsOverlay", id);
  }

  confirmClose(review) {
    if (this.busy) return;
    openOverlay({
      mod: "crit", kind: "dialog", modal: true, width: 440, height: 300,
      props: { closeReview: { id: review.id, title: reviewTitle(review), cwd: review.cwd || "Folder unavailable" } },
    });
  }

  closeDialog(t) {
    const review = props().closeReview;
    const cancel = () => closeOverlay(props().overlay);
    return v_flex().id("crit-close-dialog").size_full().min_h(0).p(18).gap(12).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && !this.busy) { cancel(); cx.stop_propagation(); }
      })
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Close review?"))
      .child(div().text_color(t.foreground).child(`${review.title} · ${review.cwd}`))
      .child(div().text_color(t.muted).child("This closes the Crit session. Saved files and comments remain, and the agent will not be interrupted. This does not Finish or Approve the review or deliver feedback."))
      .child(this.checkbox("crit-close-tab", "Also close Chrome tab", Boolean(this.closeChromeTabs && this.browserSettings?.automationSupported),
        Boolean(this.browserSettings?.automationSupported && !this.busy && !this.settingsLoading), t,
        (value, cx) => { this.closeChromeTabs = value; cx.notify(); }))
      .child(div().text_size(11).text_color(t.muted).child("macOS + Google Chrome only; requires Automation access. If the tab cannot be closed, close it manually."))
      .when(Boolean(this.message), (el) => el.child(div().text_color(t.ansi1).child(this.message)))
      .child(h_flex().justify_end().gap(8)
        .child(this.button("crit-close-cancel", "Cancel", t, cancel, { enabled: !this.busy }).track_focus(this.handle))
        .child(this.button("crit-close-confirm", this.busy ? "Closing…" : "Close review", t,
          (cx) => this.action("close", [review.id, "--confirmed", this.closeChromeTabs && this.browserSettings?.automationSupported ? "--close-chrome" : "--keep-browser"], cx), { enabled: !this.busy && !this.settingsLoading }).text_color(t.ansi1)));
  }

  checkbox(id, label, checked, enabled, t, change) {
    return Checkbox.new(id).checked(checked).disabled(!enabled).accessibility_label(label)
      .on_change((value, cx) => change(value, cx))
      .child(h_flex().gap(8).items_center()
        .child(div().size(14).rounded(3).border_1().border_color(t.border)
          .bg(checked ? t.solid : t.background).flex().items_center().justify_center()
          .when(checked, (el) => el.child(div().size(6).rounded(1).bg(t.solid_foreground))))
        .child(div().text_color(enabled ? t.foreground : t.dim).child(label)));
  }

  setAccess(data) {
    this.accessStatus = data.status;
    this.accessMessage = data.message || "";
  }

  settingsAction(verb, args, cx) {
    if (this.busy) return;
    this.busy = verb;
    this.message = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const data = await this.bridge(verb, ...args);
        if (verb === "settings") {
          closeOverlay(this.overlayId);
        } else if (verb === "chrome-access") {
          this.setAccess(data);
        } else this.message = "Opened Automation settings.";
      } catch (error) {
        if (verb === "chrome-access") { this.accessStatus = "error"; this.accessMessage = error.message || "Could not check access."; }
        else this.message = error.message || "Action failed. Try again.";
      }
      finally { this.busy = null; cx.notify(); }
    });
  }

  settingsDialog(t) {
    const cancel = () => closeOverlay(props().overlay);
    const supported = Boolean(this.browserSettings?.automationSupported);
    const enabled = Boolean(this.browserSettings && !this.busy && !this.settingsLoading);
    const accessLabel = ({
      checking: "Checking…", allowed: "Granted", denied: "Denied", "not-requested": "Not requested",
      not_requested: "Not requested", unavailable: "Unavailable", unsupported: "Unavailable",
      "multiple-instances": "Multiple Chrome instances", error: "Check failed",
    })[this.accessStatus] || this.accessStatus;
    const actionLabel = ({
      allowed: "Recheck access", denied: "Check again", "not-requested": "Request access",
      not_requested: "Request access", unavailable: "Start Chrome / request access", error: "Retry",
    })[this.accessStatus] || "Check access";
    return v_flex().id("crit-settings-dialog").size_full().min_h(0).p(18).gap(12).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && !this.busy) { cancel(); cx.stop_propagation(); }
      })
      .child(div().flex_none().text_size(15).font_semibold().text_color(t.foreground).child("Chrome integration (macOS)"))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().flex_none().gap(10)
          .child(div().flex_none().text_color(t.muted).child("Requires Google Chrome and Automation access."))
          .when(this.settingsLoading && !this.browserSettings, (el) => el.child(div().flex_none().text_color(t.muted).child("Loading settings…")))
          .when(Boolean(this.browserSettings) && !supported, (el) => el.child(div().flex_none().text_color(t.muted).child("Unavailable on this computer — macOS and Google Chrome only.")))
          .child(div().flex_none().child(this.checkbox("crit-settings-reuse", "Reuse review tabs in Chrome", Boolean(this.reuseChromeTabs), enabled && supported, t,
            (value, cx) => { this.reuseChromeTabs = value; cx.notify(); })))
          .child(div().flex_none().child(this.checkbox("crit-settings-close", "Close Chrome tab by default", Boolean(this.closeChromeTabs), enabled && supported, t,
            (value, cx) => { this.closeChromeTabs = value; cx.notify(); })))
          .child(div().flex_none().text_size(11).text_color(t.muted).child("Without access, reviews open in your default browser and tabs stay open."))
          .child(div().flex_none().text_color(t.foreground).child(`Chrome access: ${accessLabel}`))
          .when(["denied", "error", "unavailable", "multiple-instances"].includes(this.accessStatus) && Boolean(this.accessMessage),
            (el) => el.child(div().flex_none().text_size(11).text_color(t.muted).child(this.accessMessage)))
          .when(this.accessStatus === "denied", (el) => el.child(div().flex_none().text_size(11).text_color(t.muted)
            .child("In macOS Automation settings, allow the requesting app (usually Herdr) to control Google Chrome.")))
          .child(h_flex().flex_none().items_center().flex_wrap().gap(8)
            .child(this.button("crit-check-access", this.busy === "chrome-access" ? "Checking…" : actionLabel, t,
              (cx) => this.settingsAction("chrome-access", ["not-requested", "not_requested", "unavailable"].includes(this.accessStatus) ? [] : ["--check"], cx),
              { enabled: enabled && supported && !["checking", "unsupported"].includes(this.accessStatus) }))
            .child(this.button("crit-automation-settings", "Automation settings", t,
              (cx) => this.settingsAction("automation-settings", [], cx), { enabled: enabled && supported }).tooltip("Open macOS Automation settings")))
          .when(Boolean(this.message), (el) => el.child(div().flex_none().text_color(t.foreground).child(this.message)))))
      .child(h_flex().flex_none().justify_end().gap(8)
        .child(this.button("crit-settings-cancel", "Cancel", t, cancel, { enabled: !this.busy }).track_focus(this.handle))
        .child(this.button("crit-settings-save", this.busy === "settings" ? "Saving…" : "Save", t,
          (cx) => this.settingsAction("settings", ["update", JSON.stringify({ reuseChromeTabs: this.reuseChromeTabs, closeChromeTabs: this.closeChromeTabs })], cx),
          { primary: true, enabled: enabled && supported })));
  }


  currentAgent(space, list) {
    const pickedGone = this.agentPicked && !list.some((agent) => agent.address === this.agentAddress);
    if (this.space !== space?.id || pickedGone) {
      this.space = space?.id;
      if (!this.agentPicked || pickedGone) {
        this.agentAddress = null;
        this.agentPicked = false;
      }
      this.pickingAgent = false;
      this.invalidateCandidates(true);
    }
    const focus = focused();
    const inSpace = list.filter((a) => a.space === space?.id);
    const current = inSpace.find((a) => a.address === (focus?.agent || focus?.shown || focus?.terminal))
      || inSpace.find((a) => a.focused)
      || (inSpace.length === 1 ? inSpace[0] : null);
    if (!this.agentPicked && current) this.agentAddress = current.address;
    return list.find((a) => a.address === this.agentAddress) ?? null;
  }

  contextKey(space, agent, cwd) {
    return JSON.stringify([space?.id ?? null, space?.machine ?? null, agent?.address ?? null, cwd ?? null]);
  }

  updateContext(space, agent, cwd, cx) {
    const key = this.contextKey(space, agent, cwd);
    if (this.reviewContext?.key !== key) {
      this.reviewContext = { key, status: "pending" };
      this.invalidateCandidates(true);
      this.modeAt = Math.max(0, NON_GIT_MODES.findIndex((item) => item.id === this.mode));
    }
    const context = this.reviewContext;
    if (this.composing && GIT_MODES.includes(this.mode) && !this.contextReady(space, agent, cwd)) {
      this.mode = "files";
      this.story = false;
      this.modeAt = 0;
      this.invalidateCandidates(true);
    }
    if (!this.composing || !space || space.machine || !agent || !cwd || context.started) return;
    context.started = true;
    cx.spawn(async (cx) => {
      let result;
      try { result = await this.bridge("context", JSON.stringify({ cwd })); }
      catch {}
      if (this.reviewContext !== context) return;
      if (!this.composing || !this.selectionCurrent(space, agent, cwd)) {
        this.reviewContext = null;
        cx.notify();
        return;
      }
      context.status = ["ready", "not_repository", "unavailable"].includes(result?.status) ? result.status : "unavailable";
      context.message = typeof result?.message === "string" ? result.message : null;
      this.modeAt = Math.max(0, (context.status === "ready" ? MODES : NON_GIT_MODES).findIndex((item) => item.id === this.mode));
      cx.notify();
    });
  }

  selectionCurrent(space, agent, cwd) {
    const allSpaces = spaces();
    const selected = this.currentAgent(allSpaces.find((item) => item.active), agents());
    const selectedSpace = allSpaces.find((item) => item.id === selected?.space);
    const currentCwd = selected ? panes().find((item) => item.terminal === selected.address)?.cwd : null;
    return Boolean(space && agent && cwd && selectedSpace && !selectedSpace.machine
      && this.contextKey(space, agent, cwd) === this.contextKey(selectedSpace, selected, currentCwd));
  }

  contextReady(space, agent, cwd) {
    const key = this.contextKey(space, agent, cwd);
    return this.selectionCurrent(space, agent, cwd)
      && this.reviewContext?.key === key && this.reviewContext.status === "ready";
  }

  availableModes(space, agent, cwd) {
    return this.contextReady(space, agent, cwd) ? MODES : NON_GIT_MODES;
  }

  contextReason() {
    if (this.reviewContext?.message) return this.reviewContext.message;
    if (this.reviewContext?.status === "not_repository") return "Not a Git working tree. Choose another agent or review type.";
    if (this.reviewContext?.status === "unavailable") return "Cannot check Git here. Choose another agent or review type.";
    return "Checking Git folder…";
  }

  start(space, agent, cwd, cx) {
    const value = this.inputs[this.mode].value();
    if (!this.composing || !space || !agent || !cwd || this.busy) return;
    if (space.machine) {
      this.message = "Remote reviews are not supported yet. Choose an agent on this computer.";
      cx.notify();
      return;
    }
    if (!this.selectionCurrent(space, agent, cwd)) {
      this.message = "The selected agent or folder changed. Choose an agent and try again.";
      cx.notify();
      return;
    }
    if (GIT_MODES.includes(this.mode) && !this.contextReady(space, agent, cwd)) {
      this.message = this.contextReason();
      cx.notify();
      return;
    }
    if (this.mode !== "git" && !value.trim()) {
      this.message = `Enter ${MODES.find((m) => m.id === this.mode).field.toLowerCase()}.`;
      cx.notify();
      return;
    }
    const request = {
      mode: this.mode,
      story: this.story && STORY.includes(this.mode),
      target: this.mode === "files" ? uniqueFileLines(value.split("\n").filter((line) => line.replace(/\r$/, "").trim()).join("\n")) : value.trim(),
      agentAddress: agent.address,
      agentName: agentLabel(agent),
      cwd,
      machine: space.machine ?? null,
      spaceId: space.id,
    };
    this.invalidateCandidates(true);
    this.action("start", [JSON.stringify(request)], cx);
  }

  selectMode(id, space, agent, cwd, cx) {
    const mode = this.availableModes(space, agent, cwd).find((item) => item.id === id);
    if (!mode) return;
    this.mode = mode.id;
    if (!STORY.includes(mode.id)) this.story = false;
    this.modeOpen = false;
    this.invalidateCandidates(true);
    this.message = null;
    this.modeFocus.focus();
    cx.notify();
  }

  modePicker(t, space, agent, cwd) {
    const modes = this.availableModes(space, agent, cwd);
    const mode = MODES.find((item) => item.id === this.mode);
    const open = (cx) => {
      this.modeAt = Math.max(0, modes.findIndex((item) => item.id === this.mode));
      this.modeOpen = true;
      cx.notify();
      cx.timer.after(0, () => { if (this.modeOpen) this.modeListFocus.focus(); });
    };
    const close = (cx, refocus = false) => {
      this.modeOpen = false;
      if (refocus) this.modeFocus.focus();
      cx.notify();
    };
    const trigger = h_flex().id("crit-mode-trigger").flex_1().min_w(0).h(30).px(9).gap(8).items_center().rounded(6)
      .role("button").accessibility_label(`Review type: ${mode.label}, ${this.modeOpen ? "options open" : "options closed"}`)
      .bg(t.raised).cursor_pointer().hover((s) => s.bg(t.hover)).track_focus(this.modeFocus).tab_index(0)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { if (this.modeOpen) close(cx, true); else open(cx); })
      .on_key_down((e, cx) => {
        if (!["enter", "space", "up", "down"].includes(e.key)) return;
        if (this.modeOpen) close(cx, true); else open(cx);
        cx.stop_propagation();
      })
      .child(div().flex_1().min_w(0).truncate().child(mode.label))
      .child(svg("mods/workspace-chrome/chevron-down.svg").size(11).flex_none().text_color(t.muted));
    const options = v_flex().id("crit-mode-options").w_full().p(4).rounded(7).bg(t.popover)
      .role("list_box").track_focus(this.modeListFocus)
      .on_key_down((e, cx) => {
        if (e.key === "up" || e.key === "down") {
          this.modeAt = (this.modeAt + (e.key === "down" ? 1 : modes.length - 1)) % modes.length;
          cx.notify();
        } else if (e.key === "enter" || e.key === "space") this.selectMode(modes[this.modeAt]?.id, space, agent, cwd, cx);
        else if (e.key === "escape") close(cx, true);
        else return;
        cx.stop_propagation();
      })
      .children(modes.map((item, index) => h_flex().id(`crit-mode-${item.id}`).h(30).flex_none().px(8).items_center().rounded(5)
        .role("list_box_option").aria_selected(this.mode === item.id)
        .when(index === this.modeAt, (el) => el.bg(t.selected).aria_active_descendant())
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.selectMode(item.id, space, agent, cwd, cx)).child(item.label + (STORY.includes(item.id) ? " · Story available" : ""))));
    return v_flex().id("crit-mode-picker").gap(4)
      .when(this.modeOpen, (el) => el.on_mouse_down_out((_e, cx) => close(cx)))
      .child(h_flex().gap(7).items_center().child(trigger)
        .when(STORY.includes(this.mode), (el) => el.child(this.button("crit-story", this.story ? "Story: on" : "Story: off", t,
          (cx) => { this.modeOpen = false; this.story = !this.story; cx.notify(); }, { selected: this.story }))))
      .when(this.modeOpen, (el) => el.child(options));
  }

  cancelCandidateTimer() {
    this.candidateSequence += 1;
    if (this.candidateTimer) this.candidateTimer.cancel();
    this.candidateTimer = null;
    this.candidatePending = null;
  }

  invalidateCandidates(clearCache = false) {
    this.cancelCandidateTimer();
    this.candidatePicker = null;
    this.candidateLoading = false;
    if (clearCache) {
      this.candidateEpoch += 1;
      this.candidateCache = null;
    }
  }

  targetFragment(mode, value, previous) {
    let change = null;
    if (typeof previous === "string" && previous !== value) {
      let start = 0, oldEnd = previous.length, end = value.length;
      while (start < oldEnd && start < end && previous[start] === value[start]) start += 1;
      while (oldEnd > start && end > start && previous[oldEnd - 1] === value[end - 1]) { oldEnd -= 1; end -= 1; }
      change = { start, end, removed: previous.slice(start, oldEnd), inserted: value.slice(start, end) };
    }
    if (mode === "files") {
      if ((!change && value.includes("\n")) || (change && /[\r\n]/.test(change.removed + change.inserted))) {
        return { kind: "target", query: "", span: null, value };
      }
      const at = change ? change.end : value.length;
      const start = at === 0 ? 0 : value.lastIndexOf("\n", at - 1) + 1;
      let end = value.indexOf("\n", at);
      if (end < 0) end = value.length;
      if (end > start && value[end - 1] === "\r") end -= 1;
      return { kind: "target", query: value.slice(start, end), span: { start, end }, value };
    }
    if (mode === "range") {
      const parts = /^(.*?)(\.\.\.?)(.*)$/.exec(value);
      if (!parts) return { kind: "base", query: value, value };
      const start = parts[1].length, end = start + parts[2].length;
      let kind = null;
      if (change && change.end <= start) kind = "base";
      else if (change && change.start >= end) kind = "head";
      else if (!parts[1]) kind = "base";
      else if (!parts[3]) kind = "head";
      return { kind, query: kind === "base" ? parts[1] : kind === "head" ? parts[3] : "", value };
    }
    return { kind: "target", query: value, value };
  }

  autocomplete(mode, previous, cx) {
    const selection = this.composerSelection;
    if (!this.composing || this.busy === "start" || this.mode !== mode || this.targetFocus !== mode
      || !selection || !this.selectionCurrent(selection.space, selection.agent, selection.cwd)
      || (GIT_MODES.includes(mode) && !this.contextReady(selection.space, selection.agent, selection.cwd))) {
      this.cancelCandidateTimer();
      return;
    }
    const { space, agent, cwd } = selection;
    const key = JSON.stringify([mode, this.contextKey(space, agent, cwd)]);
    const fragment = this.targetFragment(mode, this.inputs[mode].value(), previous);
    const open = this.candidatePicker;
    if (open && !open.manual && open.key === key) {
      this.cancelCandidateTimer();
      Object.assign(open, fragment);
      this.candidateAt = 0;
      return;
    }
    this.invalidateCandidates();
    const sequence = this.candidateSequence;
    this.candidatePending = fragment;
    this.candidateTimer = cx.timer.after(200, (cx) => {
      this.candidateTimer = null;
      this.candidatePending = null;
      if (sequence !== this.candidateSequence || !this.composing || this.busy === "start" || this.mode !== mode
        || this.targetFocus !== mode || this.inputs[mode].value() !== fragment.value
        || !this.selectionCurrent(space, agent, cwd)
        || (GIT_MODES.includes(mode) && !this.contextReady(space, agent, cwd))) return;
      const picker = { ...fragment, mode, space, agent, cwd, key, manual: false, refresh: false };
      this.candidatePicker = picker;
      this.candidateOptions = [];
      this.candidateWarning = null;
      this.candidateAt = 0;
      this.loadCandidates(picker, cx);
      cx.notify();
    });
  }

  matchingCandidates() {
    if (!this.candidatePicker) return [];
    const picker = this.candidatePicker;
    const typed = picker.manual ? this.candidateSearch.value() : picker.query;
    const query = typed.trim().toLowerCase();
    const files = picker.mode === "files" ? this.inputs.files.value() : null;
    const span = !picker.manual && picker.span;
    const selected = files === null ? null : new Set((span
      ? files.slice(0, span.start) + files.slice(span.end) : files).split("\n").map((line) => line.replace(/\r$/, "")));
    return this.candidateOptions.filter((option) => (!selected?.has(option.value)
      || (files !== null && span && option.value === typed))
      && `${option.label} ${option.value} ${option.detail || ""}`.toLowerCase().includes(query))
      .sort((a, b) => Number(b.value === typed) - Number(a.value === typed));
  }

  pickerCurrent(picker) {
    return Boolean(picker && this.composing && this.candidatePicker === picker && picker.mode === this.mode
      && this.selectionCurrent(picker.space, picker.agent, picker.cwd)
      && (!GIT_MODES.includes(picker.mode) || this.contextReady(picker.space, picker.agent, picker.cwd)));
  }

  applyCandidateData(picker, data) {
    if (data.unavailable && GIT_MODES.includes(picker.mode)) {
      this.reviewContext.status = ["not_repository", "unavailable"].includes(data.status) ? data.status : "unavailable";
      this.reviewContext.message = typeof data.warning === "string" ? data.warning : null;
      this.invalidateCandidates(true);
      return;
    }
    const highlighted = this.matchingCandidates().slice(0, 150)[this.candidateAt]?.value;
    this.candidateOptions = Array.isArray(data.options)
      ? data.options.filter((item) => typeof item?.value === "string").map((item) => ({
        value: item.value,
        label: typeof item.label === "string" ? item.label : item.value,
        detail: typeof item.detail === "string" ? item.detail : "",
      })) : [];
    const at = this.matchingCandidates().slice(0, 150).findIndex((item) => item.value === highlighted);
    this.candidateAt = at < 0 ? 0 : at;
    this.candidateWarning = data.warning || null;
    this.candidateLoading = false;
  }

  loadCandidates(picker, cx, refresh = false) {
    const cache = this.candidateCache;
    if (cache?.key === picker.key && cache.epoch === this.candidateEpoch) {
      this.applyCandidateData(picker, cache.data);
      if (!this.pickerCurrent(picker) || !refresh) return;
    }
    this.candidateLoading = true;
    if (this.candidateRequest) return;
    picker.refresh = false;
    const request = { key: picker.key, mode: picker.mode, space: picker.space, agent: picker.agent, cwd: picker.cwd, epoch: this.candidateEpoch };
    this.candidateRequest = request;
    cx.spawn(async (cx) => {
      let data, failed = false;
      try { data = await this.bridge("candidates", JSON.stringify({ mode: request.mode, cwd: request.cwd })); }
      catch { failed = true; }
      this.candidateRequest = null;
      if (!failed && request.epoch === this.candidateEpoch && this.composing && request.mode === this.mode
        && this.selectionCurrent(request.space, request.agent, request.cwd) && request.epoch === this.candidateEpoch) {
        this.candidateCache = { key: request.key, epoch: request.epoch, data };
      }
      const current = this.candidatePicker;
      if (!this.pickerCurrent(current)) {
        if (this.candidatePicker === current) {
          this.candidatePicker = null;
          this.candidateLoading = false;
          cx.notify();
        }
        return;
      }
      if (request.epoch !== this.candidateEpoch || request.key !== current.key) {
        this.loadCandidates(current, cx, current.refresh);
      } else if (failed) {
        this.candidateWarning = "Could not load options. Enter a target manually.";
        this.candidateLoading = false;
      } else {
        this.applyCandidateData(current, data);
      }
      cx.notify();
    });
  }

  browseCandidates(kind, space, agent, cwd, cx) {
    if (!this.composing || !this.selectionCurrent(space, agent, cwd) || (GIT_MODES.includes(this.mode) && !this.contextReady(space, agent, cwd))) return;
    if (this.candidatePicker?.manual && this.candidatePicker.kind === kind && this.candidatePicker.mode === this.mode && this.candidatePicker.cwd === cwd) {
      this.invalidateCandidates();
      cx.notify();
      return;
    }
    this.invalidateCandidates();
    const key = JSON.stringify([this.mode, this.contextKey(space, agent, cwd)]);
    const picker = { kind, mode: this.mode, space, agent, cwd, key, manual: true, refresh: true };
    this.candidatePicker = picker;
    this.candidateOptions = [];
    this.candidateWarning = null;
    this.candidateAt = 0;
    this.candidateSearch.set_value("");
    this.loadCandidates(picker, cx, true);
    const sequence = this.candidateSequence;
    cx.notify();
    cx.timer.after(0, () => {
      if (sequence === this.candidateSequence && this.pickerCurrent(picker)) this.candidateSearch.focus();
    });
  }

  targetKeyDown(e, cx) {
    const picker = this.candidatePicker;
    const automatic = picker && !picker.manual;
    if (e.key === "escape" && (automatic || this.candidateTimer)) {
      this.invalidateCandidates();
      cx.stop_propagation();
      cx.notify();
      return;
    }
    const modified = e.modifiers.shift || e.modifiers.control || e.modifiers.alt || e.modifiers.platform;
    if (["left", "right", "home", "end", "pageup", "pagedown"].includes(e.key)
      || ((e.key === "up" || e.key === "down") && modified)
      || ((e.modifiers.platform || e.modifiers.control) && e.key === "a")) {
      if (automatic) this.invalidateCandidates();
      else this.cancelCandidateTimer();
      cx.notify();
      return;
    }
    if (!automatic) return;
    const options = this.matchingCandidates().slice(0, 150);
    if ((e.key === "up" || e.key === "down") && options.length) {
      this.candidateAt = (this.candidateAt + (e.key === "down" ? 1 : options.length - 1)) % options.length;
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  completeFileCandidate(cx) {
    const picker = this.candidatePicker;
    if (this.targetFocus === "files") {
      const option = picker && !picker.manual && picker.span ? this.matchingCandidates()[this.candidateAt] : null;
      if (!option || !this.chooseCandidate(option, cx)) {
        const input = this.inputs.files;
        const current = input.value();
        const next = uniqueFileLines(current);
        if (next !== current) {
          let caret = next.length;
          const fragment = picker && !picker.manual ? picker : !picker ? this.candidatePending : null;
          if (fragment) {
            if (fragment.value !== current) this.invalidateCandidates();
            else if (!fragment.span) fragment.value = next;
            else {
              const start = uniqueFileLines(current.slice(0, fragment.span.start)).length;
              const end = uniqueFileLines(current.slice(0, fragment.span.end)).length;
              if (start <= end && end <= next.length
                && next.slice(start, end) === current.slice(fragment.span.start, fragment.span.end)) {
                fragment.value = next;
                fragment.span = { start, end };
                caret = end;
              } else this.invalidateCandidates();
            }
          }
          this.inputValues.files = next;
          input.set_value(next);
          input.set_selected_range({ start: caret, end: caret });
          cx.notify();
        }
      }
    }
    cx.stop_propagation();
  }

  moveFileCandidate(step, cx) {
    const picker = this.candidatePicker;
    if (this.targetFocus === "files" && picker && !picker.manual && picker.span
      && this.pickerCurrent(picker) && this.inputs.files.value() === picker.value) {
      const options = this.matchingCandidates().slice(0, 150);
      if (options.length) {
        this.candidateAt = (this.candidateAt + step + options.length) % options.length;
        cx.stop_propagation();
        cx.notify();
        return;
      }
    }
    this.cancelFileCandidateOnMove(cx);
  }

  cancelFileCandidateOnMove(cx) {
    if (this.candidatePicker && !this.candidatePicker.manual) {
      this.invalidateCandidates();
      cx.notify();
    } else if (this.candidateTimer) {
      this.cancelCandidateTimer();
    }
    cx.propagate();
  }

  chooseCandidate(option, cx) {
    const picker = this.candidatePicker;
    if (!this.pickerCurrent(picker)) return;
    const input = this.inputs[picker.mode];
    const current = input.value();
    if (!picker.manual && current !== picker.value) {
      this.invalidateCandidates();
      cx.notify();
      return;
    }
    let next, caret;
    if (picker.mode === "files") {
      const selected = current.split("\n").some((line) => line.replace(/\r$/, "") === option.value);
      if (selected) next = current;
      else if (!picker.manual && picker.span) {
        next = current.slice(0, picker.span.start) + option.value + current.slice(picker.span.end);
      } else {
        next = current + (current && !current.endsWith("\n") ? "\n" : "") + option.value;
      }
      next = uniqueFileLines(next);
      let offset = 0;
      for (const line of next.split("\n")) {
        if (line.replace(/\r$/, "") === option.value) { caret = offset + option.value.length; break; }
        offset += line.length + 1;
      }
    } else if (picker.mode === "range") {
      if (!picker.kind) {
        this.message = "Choose base or head to replace a commit in this range.";
        cx.notify();
        return;
      }
      const parts = /^(.*?)(\.\.\.?)(.*)$/.exec(current);
      const base = parts ? parts[1] : current;
      const separator = parts ? parts[2] : "..";
      const head = parts ? parts[3] : "";
      next = picker.kind === "base"
        ? (parts || picker.manual ? `${option.value}${separator}${picker.manual ? head || "HEAD" : head}` : option.value)
        : `${base}${separator}${option.value}`;
    } else {
      next = option.value;
    }
    this.invalidateCandidates();
    this.inputValues[picker.mode] = next;
    input.set_value(next);
    if (caret === undefined) caret = picker.mode === "range" && picker.kind === "base" ? option.value.length : next.length;
    input.set_selected_range({ start: caret, end: caret });
    this.message = null;
    cx.notify();
    return true;
  }

  candidateList(t) {
    const options = this.matchingCandidates();
    const shown = options.slice(0, 150);
    return v_flex().gap(5).on_key_down((e, cx) => {
      if ((e.key === "up" || e.key === "down") && shown.length) {
        this.candidateAt = (this.candidateAt + (e.key === "down" ? 1 : shown.length - 1)) % shown.length;
      } else if (e.key === "escape") {
        this.invalidateCandidates();
        this.typing = false;
        this.handle.focus();
      } else return;
      cx.stop_propagation();
      cx.notify();
    })
      .when(this.candidatePicker?.manual, (el) => el.child(div().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.candidateSearch).w_full().h(30).px(9).rounded(6).border_1().border_color(t.border).bg(t.background).text_color(t.foreground).text_size(12))))
      .when(Boolean(this.candidateWarning), (el) => el.child(div().text_size(11).text_color(t.ansi1).child(this.candidateWarning)))
      .when(this.candidateLoading, (el) => el.child(div().py(4).text_size(11).text_color(t.muted).child("Loading options…")))
      .when(!this.candidateLoading && !shown.length && !this.candidateWarning, (el) => el.child(div().py(4).text_size(11).text_color(t.muted).child("No matching options.")))
      .when(Boolean(shown.length), (el) => el.child(v_flex().id("crit-candidates").h(Math.min(180, shown.length * 30)).overflow_y_scrollbar()
        .children(shown.map((option, index) => h_flex().id(`crit-candidate-${index}`).h(30).flex_none().px(8).gap(7).items_center().rounded(5)
          .when(index === this.candidateAt, (row) => row.bg(t.selected))
          .cursor_pointer().hover((s) => s.bg(t.hover))
          .tooltip([option.label, option.detail].filter(Boolean).join(" · "))
          .on_click((_e, cx) => { this.chooseCandidate(option, cx); })
          .child(div().flex_1().min_w(0).truncate().child(option.label))
          .when(Boolean(option.detail), (row) => row.child(div().max_w(90).truncate().text_size(11).text_color(t.muted).child(option.detail)))))))
      .when(options.length > shown.length, (el) => el.child(div().text_size(11).text_color(t.muted).child("Search to narrow the results.")));
  }

  button(id, label, t, action, { selected = false, primary = false, enabled = true } = {}) {
    return div().id(id).h(28).px(9).flex_none().flex().items_center().justify_center().rounded(6).role("button").disabled(!enabled)
      .text_size(12).bg(primary && enabled ? t.solid : selected ? t.selected : t.raised)
      .text_color(primary && enabled ? t.solid_foreground : enabled ? t.foreground : t.dim)
      .when(enabled, (el) => el.tab_index(0).cursor_pointer().hover((s) => s.bg(primary ? t.solid : t.hover)))
      .on_key_down((e, cx) => {
        if (enabled && (e.key === "enter" || e.key === "space")) { action(cx); cx.stop_propagation(); }
      })
      .on_click((_e, cx) => { if (enabled) action(cx); }).child(label);
  }

  iconButton(id, path, label, t, action, enabled = true, spinning = false) {
    const icon = svg(path).size(14).text_color(enabled ? t.foreground : t.dim);
    return this.button(id, spinning ? icon.spin(900) : icon, t, action, { enabled })
      .w(28).px(0).tooltip(label).accessibility_label(label);
  }

  toolbar(t) {
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    const on = panel && !panel.hidden && body?.active === "crit";
    const toggle = () => {
      if (on) run("layout.hide", { id: "panel" });
      else { run("layout.select", { stack: "panel-body", child: "crit" }); run("layout.show", { id: "panel" }); }
    };
    return h_flex().size_full().pr(10).items_center().bg(t.chrome).border_b(1).border_color(t.border).track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "enter" || e.key === "space") { toggle(); cx.stop_propagation(); } })
      .child(h_flex().id("panel-crit").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(toggle).child(svg("mods/crit/crit.svg").size(14)).child("Crit"));
  }

  composer(t, space, list, agent, cwd, paneByTerminal) {
    const mode = MODES.find((m) => m.id === this.mode);
    const gitRequired = GIT_MODES.includes(this.mode);
    const gitReady = !gitRequired || this.contextReady(space, agent, cwd);
    const canStart = Boolean(space && agent && cwd && !space.machine && !this.busy && gitReady);
    const startReason = !agent ? (this.agentAddress ? "Selected agent unavailable" : "Choose an agent") : !space ? "Agent space unavailable" : !cwd ? "Folder unavailable" : null;
    const showGitReason = Boolean(space && agent && cwd && !space.machine && gitRequired && !gitReady);
    const field = this.mode === "files"
      ? Textarea.new(this.inputs.files).w_full().h(74).p(8).rounded(7).border_1().border_color(t.border).bg(t.background).text_color(t.foreground).text_size(12)
      : Input.new(this.inputs[this.mode]).w_full().h(32).px(9).rounded(7).border_1().border_color(t.border).bg(t.background).text_color(t.foreground).text_size(12);
    const name = agent ? agentLabel(agent) : this.agentAddress ? "Selected agent unavailable" : "Choose an agent";
    const pickerOpen = this.candidatePicker?.mode === this.mode && this.candidatePicker.cwd === cwd;
    const manualPickerOpen = pickerOpen && this.candidatePicker.manual;
    const targetField = v_flex().gap(5)
      .child(div().text_size(11).text_color(t.muted).child(mode.field))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0)
          .when(this.mode === "files", (el) => el.key_context("CritFilesInput")
            .on_action("crit_files_complete", (_e, cx) => this.completeFileCandidate(cx))
            .on_action("crit_files_previous", (_e, cx) => this.moveFileCandidate(-1, cx))
            .on_action("crit_files_next", (_e, cx) => this.moveFileCandidate(1, cx))
            .on_action("crit_files_cursor_move", (_e, cx) => this.cancelFileCandidateOnMove(cx)))
          .when(this.mode === "files", (el) => el.on_mouse_down("right", (_e, cx) => {
            if (this.targetFocus === "files") this.cancelFileCandidateOnMove(cx);
          }))
          .on_key_down((e, cx) => this.targetKeyDown(e, cx))
          .on_mouse_down("left", (_e, cx) => {
            cx.stop_propagation();
            if (this.targetFocus === this.mode) {
              if (this.candidatePicker && !this.candidatePicker.manual) this.invalidateCandidates();
              else this.cancelCandidateTimer();
              cx.notify();
            }
          }).child(field))
        .when(this.mode !== "range", (el) => el.child(this.button("crit-browse-target", manualPickerOpen ? "Close" : "Browse", t,
          (cx) => this.browseCandidates("target", space, agent, cwd, cx), { enabled: Boolean(space && agent && cwd && !space.machine && gitReady) }))))
      .when(this.mode === "range", (el) => el.child(h_flex().gap(6)
        .child(this.button("crit-browse-base", manualPickerOpen && this.candidatePicker.kind === "base" ? "Close base" : "Choose base", t,
          (cx) => this.browseCandidates("base", space, agent, cwd, cx), { enabled: Boolean(space && agent && cwd && !space.machine && gitReady) }))
        .child(this.button("crit-browse-head", manualPickerOpen && this.candidatePicker.kind === "head" ? "Close head" : "Choose head", t,
          (cx) => this.browseCandidates("head", space, agent, cwd, cx), { enabled: Boolean(space && agent && cwd && !space.machine && gitReady) }))))
      .when(pickerOpen, (el) => el.child(this.candidateList(t)));
    return v_flex().flex_none().gap(9).px(12).pt(12).pb(14).border_b(1).border_color(t.border)
      .child(div().text_size(11).text_color(t.muted).child("Type"))
      .child(this.modePicker(t, space, agent, cwd))
      .when(this.mode === "git", (el) => el
        .child(h_flex().child(this.button("crit-advanced", this.advanced ? "Hide advanced" : this.inputs.git.value() ? "Advanced · base set" : "Advanced", t,
          (cx) => { this.advanced = !this.advanced; this.invalidateCandidates(); cx.notify(); })))
        .when(this.advanced, (e) => e.child(targetField)))
      .when(this.mode !== "git", (el) => el.child(targetField))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().tooltip(`Agent session: ${name}`)
          .text_color(agent ? t.foreground : t.muted).child(name))
        .child(this.button("crit-choose-agent", this.pickingAgent ? "Done" : "Choose agent", t, (cx) => { this.pickingAgent = !this.pickingAgent; cx.notify(); })))
      .child(h_flex().id("crit-selected-folder").w_full().min_w(0).gap(4).items_center().text_size(11).text_color(t.muted)
        .child(div().flex_none().child("Folder:"))
        .child(div().flex_1().min_w(0).truncate().text_ellipsis_middle().tooltip(cwd || "Unavailable").child(cwd || "Unavailable")))
      .when(showGitReason, (el) => el.child(div().text_size(11).text_color(t.muted).child(this.contextReason())))
      .when(this.pickingAgent, (el) => el.child(v_flex().gap(3)
        .children(list.map((item) => {
          const itemCwd = paneByTerminal.get(item.address)?.cwd;
          return h_flex().id(`crit-agent-${item.address}`).px(8).py(6).gap(8).items_center().rounded(6)
            .bg(item.address === this.agentAddress ? t.selected : t.raised).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.agentAddress = item.address; this.agentPicked = true; this.pickingAgent = false; this.invalidateCandidates(true); this.reviewContext = null; this.message = null; cx.notify(); })
            .child(v_flex().flex_1().min_w(0).child(div().truncate().child(agentLabel(item)))
              .child(div().truncate().text_size(11).text_color(t.muted).child(`${item.space_name || "Unknown space"} · ${item.address} · ${item.status}`))
              .child(div().min_w(0).truncate().text_ellipsis_middle().tooltip(itemCwd || "Folder unavailable")
                .text_size(11).text_color(t.muted).child(`Folder: ${itemCwd || "Unavailable"}`)));
        }))
        .when(!list.length, (e) => e.child(div().p(8).text_size(11).text_color(t.muted).child("No agents available.")))))
      .when(Boolean(space?.machine), (el) => el.child(div().text_size(11).text_color(t.ansi1).child("Remote reviews are not supported. Select an agent on this computer.")))
      .child(h_flex().pt(3).gap(8).items_center()
        .child(this.button("crit-start", this.busy === "start" ? "Starting…" : "Start review", t,
          (cx) => this.start(space, agent, cwd, cx), { primary: true, enabled: canStart }))
        .when(Boolean(startReason), (el) => el.child(div().flex_1().min_w(0).text_size(11).text_color(t.muted).child(startReason))));
  }

  reviewRow(review, t, liveAgents, allSpaces) {
    const mode = MODES.find((m) => m.id === review.mode)?.label || (review.mode === "review" ? "Review" : review.mode || "Review");
    const phase = PHASES[review.phase] || review.phase || "Unknown";
    const working = ["preparing_git", "preparing_story", "starting", "agent_working"].includes(review.phase);
    const attention = ["reviewing", "feedback_pending", "error"].includes(review.phase);
    const external = review.source === "external";
    const failed = ["feedback_pending", "error"].includes(review.phase);
    const statusColor = failed ? t.blocked : t.ansi3;
    const pinnedAgent = review.agentAddress ? liveAgents.find((item) => item.address === review.agentAddress) : null;
    const pinnedSpaceId = review.spaceId || pinnedAgent?.space;
    const spaceName = allSpaces.find((item) => item.id === pinnedSpaceId)?.name
      || (pinnedAgent?.space === pinnedSpaceId ? pinnedAgent?.space_name : null) || pinnedSpaceId || "Unknown space";
    const name = pinnedAgent ? agentLabel(pinnedAgent) : review.agentName || "Agent unavailable";
    const canJump = Boolean(pinnedAgent);
    const title = reviewTitle(review);
    const details = [
      title,
      mode + (review.story ? " + Story" : ""),
      review.target ? `Target: ${String(review.target).replace(/\s*\r?\n\s*/g, ", ")}` : null,
      review.cwd ? `Folder: ${review.cwd}` : null,
      review.sessionId ? `Session: ${review.sessionId}` : null,
    ].filter(Boolean).join("\n");
    const status = [phase, external ? "Opened outside panel · feedback routing unavailable" : null, review.notice, review.error].filter(Boolean).join("\n");
    return v_flex().id(`crit-review-${review.id}`).w_full().min_w(0).px(12).py(8).gap(5).border_b(1).border_color(t.border)
      .child(h_flex().w_full().min_w(0).gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().font_semibold().tooltip(details).child(title))
        .when(Boolean(review.story), (el) => el.child(div().flex_none().px(4).py(2).rounded(4).bg(t.raised).text_size(10).child("Story")))
        .child(h_flex().w(16).h(24).flex_none().items_center().justify_center().tooltip(status).accessibility_label(status)
          .child(!external && working
            ? svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(review.notice ? statusColor : t.working).spin(900)
            : failed || (!external && attention) || Boolean(review.notice)
              ? div().size(14).flex_none().rounded(4).bg(statusColor + "26").text_size(10.5).font_bold().text_color(statusColor).flex().items_center().justify_center().child("!")
              : !external && review.phase === "approved"
                ? div().size(7).mx(3).flex_none().rounded(4).bg(t.done)
                : div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim))))
      .when(external && !review.agentAddress, (el) => el.child(div().text_size(11).text_color(t.muted).child("External review")))
      .when(!external || Boolean(review.agentAddress), (el) => el.child(h_flex().w_full().min_w(0).gap(4).items_center().text_size(11).text_color(t.muted)
        .child(div().flex_1().min_w(0).truncate().tooltip(spaceName).child(spaceName))
        .child(div().flex_none().child("·"))
        .child(div().flex_1().min_w(0).truncate().tooltip(name).child(name))
        .when(Boolean(review.agentAddress), (row) => row.child(div().flex_none().tooltip(review.agentAddress).child(review.agentAddress)))))
      .child(h_flex().w_full().gap(6).items_center()
        .when(!external && review.reconnectable === true, (el) => el.child(this.button(`crit-reconnect-${review.id}`, "Reconnect", t,
          (cx) => this.action("reconnect", [review.id], cx), { enabled: !this.busy })))
        .when(!external && review.phase === "feedback_pending", (el) => el.child(this.button(`crit-deliver-${review.id}`, "Retry", t,
          (cx) => this.action("deliver", [review.id], cx), { enabled: !this.busy }).tooltip("Retry feedback handoff")))
        .when(!external, (el) => el.child(this.button(`crit-jump-${review.id}`, "Agent", t,
          () => run("agent.focus", { terminal: review.agentAddress }), { enabled: canJump }).tooltip("Go to agent").accessibility_label("Go to agent")))
        .child(this.button(`crit-open-${review.id}`, "Open", t,
          (cx) => this.action("open", [review.id], cx), { enabled: Boolean(review.url) && !this.busy }).tooltip("Open review").accessibility_label("Open review"))
        .child(this.button(`crit-close-${review.id}`, "Close", t,
          (cx) => this.confirmClose(review, cx), { enabled: !this.busy }).text_color(t.ansi1).tooltip("Close review")));
  }

  render(cx) {
    const t = theme();
    if (props()?.toolbar) return this.toolbar(t);
    if (props()?.closeReview) return this.closeDialog(t);
    if (props()?.settings) return this.settingsDialog(t);
    const allSpaces = spaces(), activeSpace = allSpaces.find((s) => s.active);
    const allAgents = agents();
    const agent = this.currentAgent(activeSpace, allAgents);
    const space = allSpaces.find((s) => s.id === agent?.space);
    const paneByTerminal = new Map(panes().map((pane) => [pane.terminal, pane]));
    const cwd = agent ? paneByTerminal.get(agent.address)?.cwd : null;
    this.composerSelection = { space, agent, cwd };
    this.updateContext(space, agent, cwd, cx);
    const reviews = this.reviews;
    const composeLabel = this.composing ? "Close new review" : "New review";
    const refreshing = this.busy === "discover" || (this.loading && this.firstLoad);
    const setComposing = (open, cx) => {
      this.composing = open;
      this.reviewContext = null;
      this.invalidateCandidates(true);
      this.modeOpen = false;
      this.message = null;
      cx.notify();
    };
    return v_flex().id("crit").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); } })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Crit"))
        .child(div().flex_1())
        .child(this.iconButton("crit-compose", this.composing ? "mods/workspace-chrome/x.svg" : "mods/workspace-chrome/plus.svg", composeLabel, t,
          (cx) => setComposing(!this.composing, cx)))
        .child(this.iconButton("crit-discover", "frame/settings/refresh.svg", "Refresh sessions", t,
          (cx) => this.action("discover", [], cx), !this.busy && !(this.loading && this.firstLoad), refreshing))
        .child(this.iconButton("crit-settings", "mods/workspace-chrome/settings.svg", "Settings", t, () => this.openSettings())))
      .child(v_flex().id("crit-content").flex_1().min_h(0).overflow_y_scrollbar()
        .when(this.composing, (el) => el.child(this.composer(t, space, allAgents, agent, cwd, paneByTerminal)))
        .when(Boolean(this.message), (el) => el.child(div().px(12).py(8).text_size(11).text_color(t.ansi1).child(this.message)))
        .when(Boolean(this.listError), (el) => el.child(div().px(12).py(8).text_size(11).text_color(t.ansi1).child(`Can't load reviews: ${this.listError}`)))
        .children(reviews.map((review) => this.reviewRow(review, t, allAgents, allSpaces)))
        .when(!reviews.length && !this.composing, (el) => el.child(v_flex().flex_1().min_h(180).px(12).items_center().justify_center()
          .child(div().text_size(12).text_color(t.muted).child(this.loading && this.firstLoad ? "Loading reviews…" : this.listError ? "Reviews unavailable" : "No reviews yet.")))));
  }
}
