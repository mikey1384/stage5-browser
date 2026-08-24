# X upload dogfooding: Stage5 Browser 0.5.0–0.5.1

## Workflow evidence

After Stage5 Browser 0.4.6 preserved the signed-in X session and opened the composer under `@stage5tools`, the Rick Rubin workflow stopped before attachment. The prepared 1080p video was 32:27 and about 960 MB. At that checkpoint, nothing had been posted.

The composer snapshot exposed no safe upload operation. Its media picker appeared as an unlabeled generic element, while the 22-tool catalog contained neither a file-input nor file-chooser primitive.

- Composer navigation operation: `4a1c4b0e-8302-4f18-b9bc-cc835d872b4b`
- Snapshot operation: `49d1560d-f180-4a85-9b3a-7d987afdff57`
- Snapshot ID: `99c4e573-693b-4315-b87c-55464b7d5887`

Two secondary failures were preserved:

- Media-tab selection operation `fdb6e773-5fa2-49dd-9f25-3c479e6b976e` dispatched successfully, but `expectedSelected: true` timed out immediately before a fresh snapshot confirmed selection.
- Scroll operation `5335e17f-7e22-4e7c-9c85-6740ee37ff9d` returned `endReached: true` after only 10 visible videos even though the profile reported 191 media items. It proved only that the document was at its current geometric boundary.

## 0.5.0 remedy

`browser_snapshot` now inventories a bounded set of HTML file inputs independently of the ARIA tree. Hidden inputs receive opaque refs bound to the exact snapshot, frame, document version, and observed element handle. `browser_set_input_files` accepts only one of those fresh refs and explicit absolute local paths.

Before dispatch it rejects missing or unreadable files, relative paths, symlinks, directories, disabled inputs, and unsupported multiple selection. It invokes Playwright's file-input operation directly, so the agent never sees or drives a native picker. The snapshot capability is consumed once. The operation journal never receives its arguments, and results contain basenames and sizes rather than absolute paths.

After dispatch, Stage5 Browser verifies the input's privacy-minimized `FileList` metadata and returns a new semantic preview. A bounded processing observation combines generic semantic progress controls, optional caller-supplied completion/error markers, and temporal-only page/network counts. The terminal processing state is one of:

- `completion_observed`
- `in_progress`
- `error_observed`
- `unverified`

Successful file selection and successful HTTP responses are never presented as proof of processing completion. An ambiguous failure is not replayed.

The click postcondition loop now performs one final deadline-bound reconciliation after its last wait. This closes the race where the selected state became visible at the boundary but was not checked.

Scroll output now separates `documentBoundaryReached` from semantic `endReached`. A downward boundary without an explicit visible end marker is `geometric_boundary_unconfirmed`; if the controller previously observed dynamic growth and the final step neither moves nor grows, it returns `dynamic_content_stalled`. Neither state claims the feed is complete.

## Regression acceptance

The browser fixture suite proves that:

1. A hidden video input appears in `fileInputs` with a usable opaque ref.
2. A relative path fails before dispatch without consuming the valid snapshot capability.
3. A regular local file is selected, observed during the input event even when the application immediately clears the control, represented in the fresh preview, and reaches a caller-supplied completion marker.
4. No absolute local path appears in the result.
5. Reusing the old snapshot/ref fails closed.
6. A selected-state change during the final postcondition wait succeeds instead of falsely timing out.
7. A dynamically growing page that later stalls at its current bottom returns `endReached: false` and `dynamic_content_stalled`.

## Host pickup

The original 0.5.0 release added one MCP tool and one MCP-to-worker command, so it intentionally incremented both public contracts: 23 tools, tool-catalog version 4, and worker protocol 4. A host that loaded 0.4.6 had to reconnect once to discover `browser_set_input_files`; that was a genuine catalog change. The direct `stage5_browser` registration already points at this checkout's built launcher, so there was no deployment, marketplace reinstall, duplicate registration, or manual patch step.

After reconnection, the original X agent should verify `browser_status` reports 0.5.0, 23 tools, and `restartRequired: false`; take a fresh composer snapshot; use the observed video file-input ref once; wait for an explicit X processing-ready state; and stop before posting unless the user's posting instruction remains active and the final account/media/text state is verified.

## 0.5.1 production follow-up

The original workflow subsequently completed successfully and verified exactly one post:

- [Rick Rubin video on X](https://x.com/stage5tools/status/2091898710594822529)
- File-selection operation: `3ff51b7a-7863-4109-b700-cd5eeff0fa1a`
- No duplicate upload or post occurred.

That run exposed three compatible reliability gaps. X consumed the selected file and synchronously cleared its underlying input, so the 0.5.0 postcondition falsely failed even though a fresh snapshot showed the attachment uploading. Stage5 Browser 0.5.1 now arms a temporary capture-phase input/change observer before dispatch, retains only file basenames and sizes, and accepts either matching event-time metadata or a matching retained `FileList`. The observer is removed immediately. This preserves fail-closed matching without requiring the site to retain the input value.

The tool documentation now states that `observationMs` accepts 0–5,000 ms and is only the quick generic sampling window. A caller with a known semantic completion or error marker should use `completion.timeoutMs`, bounded to 60,000 ms and no greater than the overall operation timeout. Longer processing is inspected later through the fresh snapshot; selection is never replayed.

Finally, a transient auxiliary player page briefly displaced the X post page and later left `browser_tabs.activePageIndex` null. Controlled sessions now preserve a valid agent-selected page when auxiliary pages appear. Closing or crashing the selected page synchronously adopts the sole remaining live page, and `preferredPage` enforces the same invariant. Visibility-based tab reconciliation remains limited to the authentication-verification handoff or recovery from an otherwise unresolved multi-page state.

Regression coverage reproduces both the consumed-input behavior and a transient YouTube-style player page. The direct MCP registration can load 0.5.1 as a compatible worker update because tool count 23, tool-catalog version 4, and worker protocol 4 are unchanged; no host reconnect, reinstall, or deployment is required.
