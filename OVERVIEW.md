# Droid Native

將本機 Factory Droid 接入 Paseo 嘅 agent selector、對話 timeline 同 permission cards。使用 Droid 官方 TypeScript SDK 同直接 JSON-RPC transport，沿用 Droid CLI 嘅登入狀態。

需要 Paseo 0.11.4 或以上，以及已登入嘅 Droid 0.244.0+。目前版本以 macOS 同 SDK 0.9.1 驗證。Droid 必須喺 daemon host 上可以執行；可以透過 `agents.providers.droid-native.command` 設定 binary 路徑。

可以選擇 model、reasoning effort、Ask／Spec／Auto mode；顯示 streaming 回覆、thinking 同 tool 狀態，並喺 Paseo 回應工具授權同 AskUser 問題。Paseo 傳入嘅 MCP servers 會交畀 Droid。

對話喺本機 Droid session 保存；Paseo persistence 同時保存已完成 turn 嘅 timeline，用於重新開啟同 replay。Model prompts、工具內容同 MCP 資料會按你現有 Factory／MCP 設定處理。插件唔會建立 API-key 檔案。

支援 active-turn steering：工作中發送 Steer，Droid 會喺下一個 model-turn boundary 接收，正在執行嘅工具會繼續完成。圖片、PDF 同 UTF-8 文字檔用原生輸入傳入；其他附件以本機檔案參考交畀 Droid。每則訊息最多 20 個附件，原生輸入合共最多 16 MiB。

等緊工具授權時，Steer 會提示先處理 approval，保留原 turn 同草稿。開啟 host 嘅 Enable Paseo tools 後，可以建立其他 agent、跟進工作同接收完成通知。Droid Script 嘅授權卡會顯示完整 script 同全部 calls，只提供一次批准／取消；兼容層目前對應 Droid 0.244.0 嘅 protocol，升級 CLI／SDK 後需重新驗證。

Model selector 顯示 Droid 即時回報嘅 multiplier，對話 context meter 顯示 estimated 使用量同 model 上限。Paseo Usage 顯示 Factory Standard／Core quota 同 Extra Usage 餘額；quota 只讀現有 CLI login，支援 macOS Keychain 同 encrypted file store，唔會 refresh token 或更改帳戶設定。

Quota 查詢會將現有 access token 同適用嘅 organization header 傳往 Factory 官方 `api.factory.ai` 或 `api.eu.factory.ai` 嘅 `/api/billing/limits`；唔會傳 refresh token，Usage report 同 account input 亦唔包含 credentials。呢個 endpoint 係 Droid native internal API，CLI／服務更新後需重新驗證。

每次真正建立或重新開啟 session 前都會刷新 model list 同 multiplier。重疊嘅相同查詢會合併，唔保留永久 catalog cache；啟動會多一次 discovery 等待，失敗時可重試。建立前嘅 draft picker 仍由 Paseo host cache 決定，session ready 後會用最新清單。

暫時未實作匯入其他既有 Droid 對話或 Mission mode。SDK 嘅 advanced plan actions 會限制為本插件已處理嘅選項。Auto high 會直接使用 Droid 對應嘅 autonomy level；預設 Ask mode 會等待授權。
