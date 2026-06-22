# DriveBridge for Obsidian

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
- 最大ファイルサイズを超えるファイルは同期対象外です。既定は 50 MB です。
- Google Drive API の 429/5xx などは指数バックオフで再試行します。
- 同期中はロックされ、二重実行を避けます。
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

