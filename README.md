# Droid Native PoC for Paseo

獨立 Paseo provider plugin，透過 `@factory/droid-sdk` 同本機 Droid CLI 嘅 `stream-jsonrpc` 接駁。

## 安裝

需要 Node.js 22、Paseo 0.11.4+，以及已登入嘅 Droid 0.244.0+。本次驗證使用 SDK 0.9.1；插件版本係 0.2.4。

由 GitHub 安裝：

```sh
paseo plugin add git:sunnypsk/paseo-droid-plugin
```

Paseo 會用已提交嘅 lockfile 安裝 production dependencies，唔會執行 dependency lifecycle scripts。Droid CLI 需要另外安裝並登入；插件唔會自動下載 Droid。

本 repository 係社群 PoC；公開 GitHub source 唔代表已獲 Paseo 官方 registry 批准。

如果要喺本機開發：

```sh
npm ci
npm run typecheck
npm test
paseo plugin install /absolute/path/to/paseo_droid_plugin
paseo plugin ls droid-native
```

如果 `paseo` 未喺 PATH，macOS Desktop bundled CLI 喺 `/Applications/Paseo.app/Contents/Resources/bin/paseo`。

開新 agent，揀 **Droid Native (PoC)**。原有 ACP provider `factory-droid` 可以並存。預設 Ask mode；Spec 係先提案，Auto low／medium／high 對應 Droid 原生 autonomy levels。Model 同 reasoning choices 由 Droid 即時回報。

編輯後執行 typecheck，再用 `paseo plugin reload droid-native` 載入，毋須重啟 daemon。

## 實作範圍

- Streaming text／thinking、shell／read／edit／write tool rows。
- Permission 同 AskUser 接入 Paseo cards；exact MCP tool preapproval。
- Plan card 顯示完整 proposal；batch approval 列出全部操作。
- Model、reasoning 同 mode 設定；Paseo MCP server 注入。
- Model selector 顯示原生 multiplier；對話 context meter 同 Factory 帳戶 quota 接入 Paseo Usage。
- Interrupt、session close，以及本插件建立嘅對話 resume。
- Active-turn steering，保留同一 turn；steering 訊息亦可附帶圖片／文件。
- PNG／JPEG／GIF／WebP 圖片、PDF 同 UTF-8 文字檔作原生輸入；其他檔案作已驗證嘅本機檔案參考。
- Paseo persistence 保存已完成 turn 嘅 timeline snapshots；Droid 自己保存原生 context。

Paseo 嘅 daemon launch command、arguments 同 environment 會原樣傳入 transport。SDK high-level 預設啟動方式要求 API key；本插件使用 Paseo process helpers 建立 transport，再交畀 SDK，所以可以沿用 CLI login，唔需要另外寫 API-key 檔案。

Agent 工作中發送新訊息時，選擇 Paseo 嘅 **Steer**（Settings → General → Default send）。正常送達嘅指示會喺下一個 model-turn boundary 進入原有工作；正在執行嘅工具會繼續完成。若原有 turn 喺傳送期間結束，插件會回報失敗；已送達嘅內容可能保留喺 Droid history。

喺 pending AskUser 時用 composer 發送替代指示，會先確認 steering 送達，再以新指示回答舊問題，讓 Droid 喺同一 turn 繼續。Droid 嘅取消問題操作會結束 turn，所以呢度唔會用取消去解卡。

如果等緊工具／plan approval，畫面會提示先處理 approval，保留原 turn、卡片同草稿。0.2.2 已修正 rejected Steer 自動變成 Interrupt＋新 turn 嘅問題。Droid 嘅拒絕工具操作仍會結束 turn；可以先處理 approval 再 Steer，或者自行 Stop 後另發新 prompt。

無效附件／model 不支援圖片／native ACK 拒絕亦會直接顯示錯誤，唔會再因 failed disposition 觸發 Paseo 嘅 replacement fallback。連線關閉或 ACK timeout 仍可能結束原生工作；插件唔會自動重開模型 loop。

用 Paseo 嘅附件按鈕加入檔案。圖片／PDF／文字會傳入 Droid 原生 image／document input；ZIP、Office 或其他 binary 檔案會提供檔名、類型、大小同已驗證嘅本機路徑，讓 Droid 按需要選擇工具處理，唔代表已解碼內容。Paseo 文字 context、issue／PR 同 code-review context 亦有對應轉換。Timeline 只保留附件標記，唔會重複保存 base64／整份文件。

Paseo 0.11.4 即時發送時會顯示圖片／文件 preview，但 agent reload 後重新建立嘅 user row 只顯示文字，附件縮圖會消失。Droid 原生 context 仍保留附件；呢個 PoC 未補上 host 嘅附件 history rendering。

每則訊息最多 20 個附件；原生輸入合共 16 MiB、每張圖片 10 MiB、每份文字 2 MiB。其他本機檔案參考最多 256 MiB，插件只讀少量格式 header。無法讀取、大小改變、格式不符或 model 不支援圖片時會顯示錯誤。

暫時未支援既有對話匯入、Mission／child sessions、fork／rewind。插件 reload 或 process crash 發生喺 turn 中途時，Paseo replay 只保證最後保存嘅 snapshots；Droid context 仍以自身 session storage 為準。Native session 嘅 system prompt 喺建立時設定，resume 保留原值。

`config.persist=false` 只停用 Paseo persistence token；Droid CLI 仍會按本身行為保存 session。

## Model multiplier 同 Usage

Model 名稱會顯示 Droid 即時 catalog 嘅 `tokenMultiplier`，例如本次實測嘅 `GPT-6.1 Sol · 0.8×`。未知倍率唔會補成 1×，亦冇硬編 model 價格。

0.2.4 起，每次真正建立、reload 或 resume native session 前都會重新查 model list 同 multiplier；explicit catalog／Refresh providers 請求亦會重新查。只合併相同工作目錄及 session environment 嘅重疊查詢，完成後唔保留永久 cache。查詢使用同 native session 一樣嘅 env override，唔會合併不同 env 設定嘅查詢。

刷新失敗會阻止今次開啟並顯示錯誤，可重試；已運行嘅其他 sessions 繼續。選定 model 如果已移除／禁用，會先報錯，唔會靜靜轉用另一個。關閉等緊 discovery 嘅 session 會立即取消自己嘅等待，唔會取消其他 sessions 共用嘅查詢。

建立前嘅 draft picker 仍受 Paseo host snapshot cache 影響；保證更新點係 native session 啟動前，ready 後由最新 `session.config` 更新該 agent selector。未建立前要即時更新 picker，可以用 host 嘅 Refresh providers。唔會喺每次打開 selector 或每輪 prompt 自動啟動 discovery。真實 no-model probe 每次 catalog 約需 2–3 秒，速度視網絡／CLI 而定。

對話嘅 context meter 顯示 native `getContextStats()` 回報嘅目前使用量／model 上限。呢個係 Droid 嘅 estimated token occupancy，唔係累計帳單 token 或套餐 quota。開啟／resume、切換 model 同 turn 結束後會更新；新 model 資料未取得時清除舊 model 數值，查詢失敗唔會中斷工作。

Paseo Usage 嘅 **Factory** card 顯示 Standard 同 Core 各個 quota window 嘅已用／剩餘百分比、reset 時間，以及 Extra Usage USD 餘額。API 冇提供套餐總 token allowance，插件唔會推算。Window 名稱沿用 API 嘅 fiveHour／weekly／monthly，唔由倒數時間推斷週期。Paseo 會 cache 五分鐘，可喺 Usage 手動 refresh。

Quota 沿用 Droid 0.244.0 `/limits` 嘅 read-only billing endpoint；呢個係 native internal API，唔係 SDK 公開方法，CLI／服務升級後需重新驗證。插件只讀取目前 login 嘅 access token，支援 macOS Keychain 同 Factory encrypted file store；唔會 refresh token、改寫 credentials、改套餐或 Extra Usage 設定。過期／無權限／缺失資料會明確顯示問題。

Quota request 只會將現有 access token 同適用嘅 organization header 傳往 Factory 官方 `api.factory.ai` 或 `api.eu.factory.ai` 嘅 `/api/billing/limits`。唔會傳 refresh token，亦唔會將 credentials 寫入 repository、Usage report 或 account input。Prompts、附件同工具內容仍會按目前 Droid／Factory 同 MCP 設定傳送，唔代表全部資料只留喺本機。

帳戶 quota 喺側欄嘅全域 Usage 查看；對話右下角 context meter 顯示該 model 嘅 context。Paseo 0.11.4 generic plugin provider 未有 `usageSession()` bridge，所以對話 popover 暫時唔會再顯示 Factory 帳戶 card，呢個唔影響全域 Usage 或 context meter。Source 已有按 session launch environment 篩選 login 嘅實作，但現版本 host 未會呼叫佢。

Explicit API-key、airgap 或 custom API host 唔會轉用另一個 stored login 顯示訂閱 quota。Linux keyring 未實作；目前實際 quota 驗證限 macOS Keychain。Usage report 同 account input 唔包含 credentials。

## Paseo orchestration

喺 Settings → your host → Agents 開啟 **Enable Paseo tools**，再新建或 reload agent。Host 會自動注入 agent-scoped Paseo MCP；唔需要本插件另設 feature，亦唔需要手動覆寫 `mcpServers.paseo`。Paseo skill 係可選工作流程，唔係開啟工具嘅前置條件。[官方設定說明](https://paseo.sh/docs/orchestration)

Codex 可以用 Paseo `create_agent` 開 `droid-native/<model>`；Droid 亦可以用同一工具開 `codex/<model>`，再用 `send_agent_prompt` 跟進。保留 `notifyOnFinish:true`，parent 就會收到 child 完成通知；等待時唔需要輪詢。現有 Ask／Auto mode 仍然決定邊啲原生操作要 approval。

Droid 0.244.0 亦可能透過 Script 呼叫 MCP。SDK 0.9.1 未有呢種 permission schema；插件會以獨立兼容層顯示完整 script 同每個 call 嘅參數，只提供一次批准／取消。原有 SDK 支援嘅 requests 原樣通過。兼容範圍固定為 native protocol `1.269.0`、SDK protocol `1.201.1` 同 API `1.0.0`；其他未知格式會拒絕，升級 CLI／SDK 後需重新驗證。

## 代碼

- `server/provider.ts`：Paseo lifecycle、catalog、persistence、session orchestration。
- `server/transport.ts`：由 Paseo process helpers 啟動 Droid；SDK 負責 JSON-RPC。
- `server/permissions.ts`：工具、plan、AskUser callbacks。
- `server/permission-compatibility.ts`：新版 Script permission 嘅嚴格格式驗證同 request／response bridge。
- `server/usage.ts`／`server/quota.ts`：read-only Factory login、quota discovery 同 Usage report mapping。
- `server/timeline.ts`：streaming events 轉成穩定 timeline snapshots。
- `server/steering.ts`：經 SDK 公開 schema 發送 mid-loop steering，並同 SDK 共用 transport。
- `server/attachments.ts`：附件驗證、原生輸入同本機檔案參考。

參考：[Paseo provider plugins](https://paseo.sh/docs/plugins/providers)、[Factory SDK](https://docs.factory.com/sdk/typescript)。

本次實測結果同限制見 [VERIFICATION.md](VERIFICATION.md)。
