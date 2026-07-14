# DriveBridge for Obsidian

## Latest change

- 0.5.6: Separates Normal sync from Repair remote index in commands, settings, progress, completion, and error messages. Repair now states that it is a metadata-index operation rather than a normal backup, reports an explicit COMPLETE or STOPPED result, and tells the user whether to repair again or continue with Normal Preview and Normal sync.
- 0.5.5: Strengthens Duplicate Guard Auto without adding work to unchanged syncs or existing-ID updates. A lone new Drive create uses small exact-name pre/post checks; multiple creates in one parent share one cached preflight and one batched postflight. If this run created a later file whose size and non-empty MD5 exactly match the older canonical file, DriveBridge trashes only its own later ID and adopts the canonical ID in the snapshot and operation journal. Different-content or otherwise ambiguous duplicates stop before snapshot commit and are never auto-deleted. Strict additionally refreshes the whole parent immediately before every create. The same release adds stale-runtime epoch checks, batched reserved IDs and provenance for newly required folders, duplicate-aware Recovery, and a manual Preview/Apply repair flow. Repair full scans and checksum grouping run only when explicitly requested; unchanged sync and existing-ID updates receive no extra Drive request.
- 0.5.4: Makes new-file uploads recoverable with batched pre-generated Drive IDs and an atomic operation journal. Lost POST responses are reconciled by ID instead of re-uploading, legacy duplicate errors are reconciled by exact path and checksum during Recovery, and shared remote snapshot changes are merged only when its generation changed. Unchanged syncs now skip the remote snapshot query/write entirely; per-file GETs and extra hashes remain failure/Recovery-only. The sync summary reports Drive request and snapshot-write counters.
- 0.5.3: Recovers a corrupted local review queue or snapshot from its verified previous-generation backup, quarantines the damaged primary on the next successful save without replacing the known-good backup, and still stops if neither copy validates.
- 0.5.2: Compacts internal snapshot JSON and retries only transient atomic read-back mismatches, preventing large snapshots from failing on an immediate partial read while preserving corruption checks.
- 0.5.1: Prevents atomic JSON verification from falsely failing on harmless BOM, line-ending, or formatting differences while still rejecting changed or invalid content.
- 0.5.0: Adds lightweight snapshot safeguards, targeted content verification, exact-plan delete approvals, and a mobile-first BAS-style manual conflict review queue. Safe files continue syncing while conflicts wait for review.
- 0.4.33: Adds Duplicate guard Auto/Strict/Off. Auto checks Drive folder contents only before risky new uploads, using per-folder caching to avoid per-file searches.
- 0.4.32: Adds a manual remote snapshot repair action that full-scans Google Drive and rewrites only `remote_snapshot.json`.
- 0.4.31: Updates the shared remote snapshot with current Drive metadata for remote changed-before/during-sync skips, without advancing the local sync baseline.
- 0.4.30: Shows the running plugin version and planned/current remote metadata differences for changed-during-sync skips.
- 0.4.29: Allows downloads to proceed when Google Drive content is unchanged but remote metadata timestamps differ from the snapshot.
- 0.4.28: Reads and updates the newest `remote_snapshot.json` when duplicate root snapshots exist, avoiding stale snapshot selection.
- 0.4.27: Shortens remote delete tombstone retention from 30 days to 20 days so intentional manual restores stop being blocked sooner.
- 0.4.26: Adopts bulk timestamp-only local updates when Google Drive materialization touches many unchanged same-size files at once.
- 0.4.25: Keeps local files when Google Drive is merely missing a previously synced path unless a remote deletion tombstone proves the delete.
- 0.4.24: Prevents stale devices from deleting remote files when the shared remote snapshot is newer than the device's last completed sync.
- 0.4.23: Detects safe local file moves and applies them as Google Drive moves, treats files that change during manual sync as skipped instead of errors, and keeps operation journals focused on actionable sync work instead of unchanged/excluded files.
- 0.4.22: Adds configurable excluded folders, letting each vault choose local-only folders from settings without hard-coded private paths.
- 0.4.20: Upload and bidirectional remote-delete checks now tolerate stale Drive modifiedTime when the file ID, size, and md5 content still match.
- 0.4.19: Push-mode remote deletes now tolerate stale remote snapshot metadata by refreshing the Drive file by ID before trashing it.
- 0.4.18: Pull mode with `Sync deletes` now treats Google Drive as authoritative and deletes local-only files even when the device missed the original delete tombstone.
- 0.4.17: Remote deletes now write short-lived tombstones into `remote_snapshot.json`, so iPhone/iPad can delete local files even when their local snapshot missed the pre-delete baseline.
- 0.4.16: Keeps compact sync status out of the center by showing only the trailing part of long filenames, with the full path available as a tooltip.
- 0.4.15: Adds a configurable `Run compact sync` command that uses the same quiet behavior as auto sync and can be assigned in Obsidian Hotkeys.
- 0.4.14: Ensures the plugin data directory exists before writing sync journals or snapshots, with one retry for iCloud parent-folder availability races.
- 0.4.13: Adopts same-size files during the first scan and limits repeated per-file error notices to avoid UI overload.
- 0.4.12: Speeds up many small Markdown syncs by avoiding full-vault rescans after each download and batching operation journal writes.
- 0.4.11: Recovery buttons now use a dedicated responsive layout instead of a crowded settings row, fixing layout issues on narrow/mobile screens.
- 0.4.10: Recovery resume is now poka-yoke gated: run Preview recovery, discard partials if needed, run normal Preview, then Resume safe operations only when no conflict/delete risk remains.
- 0.4.9: Adds operation journaling, interrupted-sync recovery checks, partial cleanup, and large binary conflict skip for manual review.
- 0.4.8: Conflict handling now adopts same-size files when local MD5 matches Google Drive MD5, and downloads now write to a verified partial file before replacing the final file.
- 0.4.7: Sync progress now uses transferred/affected data size instead of processed file count during real sync.
- 0.4.6: Safe `.obsidian` sync now always excludes OS junk, temporary, and conflict-copy files such as `desktop.ini`, `.DS_Store`, and `Thumbs.db`.
- 0.4.5: remote smart mirror snapshot support, configurable conflict handling, configurable protect-modify threshold, and safer execution ordering.
- Auto sync now runs quietly: it updates the status bar but does not open the large progress modal unless an error needs attention.
- Auto sync now skips files that change while it is running, and rechecks Google Drive metadata before overwrite/delete/download conflict-sensitive operations.
- Sync progress now shows as `current/total (percent)` in the progress modal and desktop status bar.
- Safe `.obsidian` sync now scans `.obsidian` through the Obsidian adapter, so themes and plugin files can be uploaded/downloaded.
- Sync errors now stay visible in the progress modal instead of disappearing after a short notice.
- Error details include the action, vault path, error message, and time.
- The same details are saved to `sync-journal.json` and shown in the DriveBridge settings summary.

## Manual conflict review (0.5.0)

- `Manual review` is the recommended conflict mode. Safe files keep syncing while conflicts wait in `review-queue.json`.
- Open `Review sync conflicts` from the command palette, ribbon, or DriveBridge settings.
- Each pending item shows Local and Google Drive metadata and offers `Use Local`, `Use Drive`, `Keep both`, or `Defer`.
- DriveBridge rechecks both sides immediately before applying a review choice. A stale choice is rejected instead of overwriting newer content.
- On iPhone/iPad, the review and settings layouts stack vertically with full-width touch controls; no desktop-only right-click or hover action is required.
- Large ambiguous files are queued without automatic full-content hashing, keeping normal mobile sync lightweight.

## Recovery and performance behavior (0.5.4 and later)

- New file IDs are reserved in batches of up to 1000 and written to `operation-journal.json` before any upload mutation.
- A normal successful upload has no follow-up GET and no extra local MD5 pass. Targeted ID/path lookup and hashing run only after an ambiguous network result or during Recovery.
- A no-change sync does not query or rewrite `remote_snapshot.json` at commit time.
- If another device changed `remote_snapshot.json` after this device scanned it, DriveBridge downloads that latest snapshot and merges only this run's verified path mutations. A same-path concurrent edit stops for Recovery/manual review.
- The local `snapshot.json` is committed after the shared remote snapshot. `commit_pending` and failed journals are recoverable after a crash or network disconnect.
- Update DriveBridge on every device before resuming multi-device sync. After a device has observed protocol v2, a later v1 snapshot is treated as an older-client downgrade and sync stops instead of overwriting it.
- Duplicate Guard Auto adds no Drive request to an unchanged sync or an update of an existing Drive ID. A lone create uses two small exact-name queries total. Multiple creates in one parent use one cached preflight plus one batched postflight for that parent, regardless of file count. A second postflight is used only after a real same-content race, giving the other current DriveBridge device time to remove its own later duplicate.
- **Normal sync** uploads/downloads planned vault files. **Repair remote index** is a separate manual metadata scan that rewrites only `remote_snapshot.json`; it is not a normal backup. The UI reports `REPAIR COMPLETE` or `REPAIR STOPPED WITH ERROR` and tells you whether Normal Preview can be run next.

DriveBridge for Obsidian は、iCloud Drive を使わずに Obsidian vault と Google Drive を同期するためのコミュニティプラグインです。iPhone/iPad の Obsidian モバイルでも動くように、OS のローカル同期フォルダではなく Obsidian Vault API と Google Drive API を使います。

## 本番仕様の考え方

- Google Drive アプリのローカル同期フォルダは使いません。
- Google Drive API の OAuth device flow で認証します。
- Google Drive 側の同期ルートは、設定した `Root folder name` のフォルダです。
- OAuth scope は `https://www.googleapis.com/auth/drive.file` です。
- `.obsidian`、`.trash`、OSメタデータ、競合コピー、tmpファイルは既定で除外します。
- 初期状態では `Preview by default` がオンです。自動同期やコマンド実行は、まず差分計画だけを作ります。
- 初回スナップショットがない状態でローカルとDriveの両方にファイルがある場合、実同期は `Allow first real sync once` を明示的にオンにしない限り止まります。
- 削除同期は既定で無効です。有効化した場合でも、実削除ではなく Obsidian/Drive のゴミ箱扱いにします。
- `.obsidian` 同期は既定で無効です。`Obsidian config sync` を `Safe` にすると、テーマ、CSS snippets、ホットキー、プラグイン本体などの安全寄りファイルだけ同期します。
- 最大ファイルサイズを超えるファイルは同期対象外です。既定は 50 MB です。
- Google Drive API の 429/5xx などは指数バックオフで再試行します。
- 同期中はロックされ、二重実行を避けます。
- 同期中はステータスバーと進捗モーダルに進捗を表示します。iPhone/iPad ではモーダル表示を目印にしてください。同期完了までノート編集は避けてください。
- 同期計画と実行結果は設定画面に表示され、`sync-journal.json` に直近ログを保存します。

## Google Drive API スコープの制限

このプラグインは安全性と個人利用の扱いやすさを優先して `drive.file` スコープを使います。このスコープは非センシティブですが、アプリが作成したファイル、またはユーザーがアプリに共有したファイルへのアクセスに限定されます。

Drive全体を無条件に読む `drive` スコープは restricted scope で、公開アプリとして運用する場合はGoogle側の追加審査・セキュリティ要件が重くなります。そのため、このプラグインの本番仕様は「Drive全体同期」ではなく「DriveBridgeが管理する同期ルートを堅牢に同期する」設計です。

## インストール

1. `drivebridge_obsidian_sync` フォルダの中身を vault の `.obsidian/plugins/drivebridge-obsidian-sync` にコピーします。
2. Obsidian を再起動します。
3. `Settings -> Community plugins` で `DriveBridge for Obsidian` を有効化します。

## Google OAuth 設定

1. Google Cloud Console でプロジェクトを作成します。
2. Google Drive API を有効化します。
3. OAuth consent screen を設定します。
4. OAuth Client ID を作成します。
   - device flow を利用できるクライアント種別を使います。
   - 環境によっては TV/limited input client が必要です。
5. プラグイン設定に Client ID を入力します。
6. 必要なクライアント種別の場合だけ Client Secret を入力します。
7. `Step 1: Get code` を押し、表示されたURLとコードでGoogle認証します。
8. 認証後に `Step 2: Finish` を押します。

## 同期モード

- `Bidirectional`: 通常モード。ローカルとGoogle Driveの両方の変更を反映します。
- `Push local to Drive`: ローカルvaultを正としてDriveへ送ります。初回移行向けです。
- `Pull Drive to local`: Drive側を正としてローカルvaultへ取り込みます。閲覧端末の初期化向けです。

## 同期判定の仕組み

同期時には、次の3つを比較します。

- ローカルvaultの現在状態: path、size、mtime
- Google Driveの現在状態: path、file id、size、modifiedTime、md5Checksum
- 前回同期スナップショット: 前回成功時のローカル/リモート状態

判定は以下の流れです。

- ローカルのみ存在: Driveへアップロード
- Driveのみ存在: ローカルへダウンロード
- 両方存在し、前回からどちらも変わっていない: 何もしない
- ローカルだけ変わった: Driveへアップロード
- Driveだけ変わった: ローカルへダウンロード
- 両方変わった: Drive版を `*.conflict-YYYYMMDD-HHMMSS` としてローカル保存し、ローカル版をDriveへアップロード
- 初回スキャンで両方に同じサイズのファイルがある: 既存ファイルとして採用
- 初回スキャンで両方に違うサイズのファイルがある: 競合扱い

実同期が成功すると、`snapshot.json` が更新されます。次回以降はこのスナップショットとの差分で変更を判断します。

## 推奨運用

1. `Preview by default` をオンにしたまま認証します。
2. `Preview` を押して、アップロード/ダウンロード/競合の数を確認します。
3. 初回で両側にファイルがある場合は、計画を確認してから `Allow first real sync once` をオンにします。
4. `Run sync` を押します。
5. 問題がなければ `Preview by default` をオフにするか、自動同期を設定します。
6. `Sync deletes` は、通常運用が安定してから必要な場合だけオンにします。

## Google Drive同期ルート

`Root folder name` は Google Drive 側の同期ルート名です。同名フォルダが複数見える場合、DriveBridge は安全のため同期を止めます。その場合は、Google Drive 上で不要なフォルダをリネームするか、設定画面の `Root folder ID` に使いたいフォルダのIDを直接入力してください。

同期ルート名を編集中に一時的な名前で保存すると、保存済みフォルダIDがリセットされます。同期ルートを変更する前には Preview 結果を必ず確認してください。

## 同期中の注意

同期中はステータスバーに `DriveBridge sync ...` と表示され、画面中央にも進捗モーダルが出ます。iPhone/iPad ではステータスバーが見えにくい場合があるため、進捗モーダルを同期中の目印にしてください。同期中にノートを編集すると、計画作成時の状態と実際のファイル状態がズレるため、アップロード漏れや上書きの原因になります。

DriveBridge はアップロード・ダウンロード・ローカル削除の直前にローカルファイルが計画時から変わっていないか確認します。変わっていた場合、そのファイルはエラーとして扱い、次回同期で再確認できるようにします。

## `.obsidian` Safe同期

`Obsidian config sync` は既定で `Off` です。この状態では従来通り `.obsidian/**` を同期対象から除外します。

`Safe` にすると、以下だけを同期対象にします。

- `.obsidian/appearance.json`
- `.obsidian/core-plugins.json`
- `.obsidian/community-plugins.json`
- `.obsidian/hotkeys.json`
- `.obsidian/snippets/**`
- `.obsidian/themes/**`
- `.obsidian/plugins/*/manifest.json`
- `.obsidian/plugins/*/main.js`
- `.obsidian/plugins/*/styles.css`

以下は `Safe` でも常に除外します。

- `.obsidian/workspace.json`
- `.obsidian/workspace-mobile.json`
- `.obsidian/plugins/*/data.json`
- `.obsidian/plugins/drivebridge-obsidian-sync/**`
- `.obsidian/plugins/drivebridge_obsidian_sync/**`

これにより、テーマ、スニペット、ホットキー、プラグイン本体は同期できますが、OAuth token、プラグイン個別設定、DriveBridge自身の `data.json`、`snapshot.json`、`sync-journal.json` は同期しません。

## 生成ファイル

プラグインフォルダ内に以下を保存します。

- `data.json`: Obsidianプラグイン設定。OAuth tokenもここに入ります。
- `snapshot.json`: 前回同期に成功したローカル/Drive状態。
- `sync-journal.json`: 直近同期の計画または実行結果。

これらは `.obsidian/**` の既定除外により、DriveBridge自身の同期対象には含めません。

## 制限

- Google Docs/Sheets/Slides などの Google Workspace ネイティブファイルはObsidian vault同期対象として扱いません。
- `drive.file` スコープの制限により、DriveBridgeがアクセス権を持たない既存Driveファイルは見えない場合があります。
- 巨大vaultの初回同期は時間がかかります。
- iOSのバックグラウンド実行はObsidian/OS側の制限を受けるため、常時同期サービスではありません。
- 実機のOAuth認証とGoogle Drive通信には、ユーザー環境のGoogle Cloud設定が必要です。

