# DriveBridge for Obsidian

## Latest change

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

