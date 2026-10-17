# Droid Native 驗證記錄

日期：2026-10-17。環境：macOS、本機 Desktop-managed Paseo 0.11.4、Droid 0.244.0、Factory SDK 0.9.1。

## 自動化

- `npm run typecheck` 通過。
- `npm test`：109／109 通過（0.2.4）。
- 包括 permission／AskUser、exact MCP preapproval、stream terminal 去重、concurrent prompt、interrupt、close-during-init、catalog cleanup、persistence replay、transport framing／shutdown。
- Provider fake-native tests 會以 Paseo `ProviderEventSchema` 驗證全部 emitted events。
- 新增 native steering request／ACK multiplex、attachments forwarding、同一 turn ID、ordered steering、late ACK、stop-during-attachment-read、unsupported-image model、格式／大小／路徑檢查。
- Plan UI fields、完整 batch approval、AskUser supersede、pending tool admission、attachment preparation／ACK 期間新出現 approval，以及跨 turn ACK race 均有 regression tests。
- Script compatibility tests 使用 installed SDK `DroidClient` 同真實 Permissions handler，覆蓋 native protocol／option presentation fields、完整 review、明確 Once／Cancel、原有 frames 原樣通過、未知格式拒絕、duplicate IDs、interrupt／close 同 late response。
- 0.2.3 新增 multiplier validity、context 與 per-turn counters snapshot 合併、model 切換失敗唔沿用舊容量、stats timeout／close 隔離、startup late subscriber、quota window 缺失／過期、USD conversion、credential rotation／nullable metadata／env scope／error redaction tests。

## Public Git 發布準備

- Manifest 加入鎖定嘅 production dependency 安裝步驟：`npm ci --omit=dev --ignore-scripts`。喺只複製 tracked source 嘅乾淨目錄成功安裝，並驗證 SDK 嘅 `createSession`／`resumeSession`／`listModels` exports；無建立 model turn 或呼叫 login。
- 發布設定更新後，typecheck 同全部 109 個 tests 再次通過。
- Gitleaks 8.30.1 掃描發布前嘅完整 Git history 同準備公開嘅 source，未發現 secrets。另檢查 tracked paths 同 lockfile，確認無 credentials／environment／private-key 檔案，419 個 dependency entries 均有版本、官方 npm resolved URL 同 SHA-512 integrity，URL 無內嵌認證。
- `.test-output/`、`node_modules/`、本機 environment、Factory／Paseo 設定同常見 credential／key files 已設為 Git ignored。測試使用合成 credentials，唔包含實際 login；原始實測輸出保留喺本機 `.test-output/`，無包含喺公開 source。
- 呢啲係本機發布前檢查，唔代表 Paseo registry 已完成 review 或批准上架。

## 真實 Droid／Paseo

- Plugin `droid-native` 本機安裝成功，狀態 `running`，provider `available`。
- 明確移除 `FACTORY_API_KEY` 嘅 no-model catalog probe 成功，取得 67 個 models，沿用已登入 CLI。
- Paseo provider discovery 取得同一份 67-model catalog，同 Ask／Spec／Auto modes。
- 測試 agent `cb81ef06-f3f5-48c6-a56c-cc47732f9e96` 使用 `droid-native/gpt-6-luna`、low reasoning、Ask mode。
- 真實 Execute permission 經 Paseo request／response bridge，選 `proceed_once` 後寫入 `.test-output/droid-proof.txt`；內容為 `PASEO_DROID_NATIVE_7F3C`。
- Droid 回覆同一 marker；Paseo persistence 保存 user／reasoning／completed tool／assistant snapshots。
- 執行 `paseo agent reload` 重啟測試 agent 後，再要求唔用 tools／唔讀檔回憶 marker；成功回覆原值，證明 native context resume。
- 真實 AskUser request 成功轉成 Paseo question payload；執行 Stop 後返回 idle，pending permissions 為 0。

## 0.2.0 steering／附件

- 透過官方 Paseo SDK 嘅 public API，向同一個測試 agent 傳入合成 PNG、PDF 同 UTF-8 文字檔。
- Agent 禁用工具讀檔，仍正確回覆：`Left: red; right: blue; PDF: PDF_MARKER_5A91; text: TEXT_NOTE_9B72`。
- Agent 等待 AskUser 回應期間，以 `activeTurnBehavior: "steer"` 更新最終輸出要求；回應問題後得到 `STEERED_PASEO_RESULT`。
- 完整 event subscription 只收到一次 `turn_started` 同一次 `turn_completed`，兩者 turn ID 都係 `c02eb9ca-d847-4181-8ee5-bd6bb2581e3d`；無 canceled／failed event。
- 原生 Droid CLI 另外做咗 sleep-tool 邊界 probe：工具執行中加入 steering，原有工具完成，收到新指示，只有一個 completion，無 interrupt。
- Request 用 `queuePlacement: "end_of_turn"` 同 `skipAgentLoop: true`。Idle probe 確認只 append history，觀察期無 model／tool／usage event，唔會另啟 loop。
- 原始證據：`.test-output/paseo-features-smoke.json`、`steering-native-skip-probe.json`、`steering-native-idle-probe.json`、`final-unit-tests.tap`。

## 0.2.1 原生 steering 組合實測

- 原生 Execute sleep 工具執行期間，同時注入 PNG、PDF 同文字附件。Droid 正確回覆 `STEER_ATTACH_OK`、red／blue、`PDF_MARKER_5A91` 同 `TEXT_NOTE_9B72`。
- 只有一次 native result（success、interrupted=false），無 interrupt request；原有工具完成後處理 steering。
- 真實 UI 測試曾捉到 AskUser 清理錯誤：`cancelled:true` 令 Droid 直接結束 loop，新指示雖已送達但無回覆。已改成 ACK 後以實際新指示作 freeform answer；Stop／close 仍使用 cancellation。
- 修正後獨立 native probe 成功輸出 `ASK_SUPERSEDE_STEER_OK`：一條 AskUser、一次 result、零 interrupt。
- 原始證據：`.test-output/steering-attachments-live.json`、`askuser-steering-supersede-proof.json`。

## Desktop UI（full access）

使用者開啟 full access 後，Computer Use 操作同截圖穩定保留喺測試 tab。之前未完成嘅原因係每次 approval 會返回開發對話，導致目標 tab 失焦；唔係 Droid provider 自行切換 tab。今次經官方 `paseo agent open` 定位，再用 native app accessibility、click 同 screenshot 實測。

- Provider／model picker：顯示 Droid Native (PoC)、robot icon 同 GPT-6 Luna 搜尋結果。
- Reasoning picker：None／Low／Medium／High／Extra high／Max；mode picker：Ask／Spec／Auto low／medium／high。
- 經 Upload file 實際加入 PDF、文字檔，再用 Add image 加入 PNG。發送前後都有 filename cards 同紅藍縮圖。
- UI 送出後，Droid 無用工具仍正確回覆 `UI_ATTACHMENT_OK left red/right blue; PDF_MARKER_5A91; TEXT_NOTE_9B72`。
- AskUser：問題、One／Two radio buttons、Other input、Dismiss／Submit 均可見；選 Two 並 Submit 後，Droid 回覆 `Two`。
- 修正後再開 AskUser，直接用 composer 嘅 Send and steer 發送新指示；舊卡消失，Droid 正確回覆 `UI_STEER_FIXED_OK`。Event subscription 只有一次 start 同一次 complete，turn ID 均為 `3daba7e6-771b-4f15-9152-01fb6e8739e7`，無 canceled／failed。
- Tool approval：可見完整命令嘅 accessibility text、allow-once／always／cancel buttons；只點 allow-once，成功寫出 `.test-output/ui-tool-proof.txt`，內容 `UI_TOOL_OK`，並顯示同一回覆。
- Spec plan card：完整顯示 `UI_PLAN_MARKER_83A2`、兩個 numbered steps 同 `END_PLAN_83A2`；點 No, keep iterating on spec 後返回 idle，無執行計劃。
- 新測試 agent `b45c20af-2502-47dd-b590-a7d7095f6f83` 等待 Execute approval 時，點 Send and steer 要求放棄寫檔。Provider 回報不可用，Paseo 轉 Interrupt／replacement，回覆 `UI_GUARD_CANCELLED`；`.test-output/ui-guard-must-not-exist.txt` 確認不存在。呢個係 fallback，唔係同一 turn steering。
- 測試期間將 Default send 由 Queue 暫時改成 Steer；完成後已經 UI 還原 Queue。兩個測試 agent 最後均為 idle、activeTurn=null、pending permissions=0。
- 修正後 UI turn events：`.test-output/ui-after-fix-events.json`。Screenshot／AX 證據已喺 Computer Use 工具輸出檢視，無聲稱另外保存本機 screenshot 檔。

## 0.2.2 rejected Steer 修正

- Plugin 直接 reject 未獲接收嘅 steering `send()`，保留原錯誤；唔再 emit 會被 host 視為 unavailable 嘅 failed disposition。一般 prompt 仍然非同步，唔會阻住 permission／interrupt。
- 用 unmodified installed Paseo adapter 同 AgentManager methods 做 model-free integration：舊 failed-event 對照會 cancel＋replacement；新 pending-tool／invalid-image／rejected-ACK 都係 error，cancel=0、replacement=0。成功 steering 保留同一 ID。
- 真實 UI 再試 pending Execute → Send and steer：顯示 Resolve the pending Droid tool approval，原 approval card 同草稿保留。
- 前後 active turn 同為 `e1b4b0eb-608c-44b2-87fe-98854bc8d571`；permission ID 同為 `droid-permission-5a03f63a-a9bb-4e9b-9c24-e7e7eea4e43f`。測試後明確 deny，返回 idle；`ui-guard-022-must-not-exist.txt` 不存在。
- 證據：`.test-output/steering-rejection-installed-host.json`、`ui-steer-rejection-022.json`。

## Paseo MCP orchestration 實測

- Root Codex 經真實 Paseo `create_agent` 建立 native Droid parent `a62121e4-3bb0-4513-9fc4-2dfe3927d696`，model `gpt-6-luna`，Ask mode。
- Droid 讀取 Paseo skill，使用實際 `paseo___list_profiles`／`list_providers`／`list_models`，再用 `paseo___create_agent` 建立 Codex child `8fea1eae-223a-48cb-b867-3a2a5c86a484`（`codex/gpt-6.1-sol`、Full Access、low）。
- Codex child 回覆 `CODEX_CHILD_R7E2`；Droid 收到自動通知後，用 `paseo___send_agent_prompt` 跟進同一 child；再收到 `CODEX_FOLLOWUP_M9D4` 通知，最終回報 `ORCHESTRATION_COMPLETE` 同兩個真實 replies。
- Parent 冇輪詢 `get_agent_status`／`list_agents`，冇用 CLI／Factory Task 代替 MCP。Ask mode 嘅 MCP permissions 由 root 逐次選 proceed_once，冇選 always allow。
- 真實 MCP batch approval 同時包含 list_profiles／list_providers；UI 可捲動睇到兩項完整 review，補上之前未做嘅 batch card 視覺證據。
- 證據：`.test-output/orchestration-parent-timeline.json`、`orchestration-live-events.json`，以及 Codex child 嘅兩個實際 user／assistant turns。

### Reload／Script MCP compatibility

- Reload 後曾出現「工具不可用」嘅模型回覆；原始 ToolSearch 結果實際係工具已存在。Public SDK inventory 亦確認 `paseo___send_agent_prompt` registered／allowed，所以唔將模型回覆當成工具遺失證據。
- 改用 `gpt-6.1-sol`、medium、Ask 後，實際呼叫暴露另一個問題：Droid 0.244.0 嘅 Script permission 未納入 SDK 0.9.1 schema。新增兼容層，只接收已確認嘅 API `1.0.0`／native protocol `1.269.0`，並保留 SDK protocol `1.201.1` 原有處理。Native options 嘅 `selectedColor`／`selectedPrefix` 只作 presentation strings。
- 新版 Script card 經 Desktop AX 同 screenshot 核對，完整 script、解析後嘅 child ID／prompt／background／notifyOnFinish 均可捲動檢視；只提供 allow-once／cancel。Root 逐次選 once，冇改 persistent MCP config／tool policy。
- 首次成功傳遞得到 `CODEX_RELOAD_P4A7.`；MCP 同通知成功，但因多一個句號，嚴格字串比對未通過。用明確 tag-delimited prompt 再做一次格式檢查，Codex child 精確回覆 `CODEX_RELOAD_Q6B9`，Droid 精確回覆 `ORCHESTRATION_RELOAD_OK: CODEX_RELOAD_Q6B9`。
- 最終 proof 獨立 assert：parent 嘅 Script 同 `paseo___send_agent_prompt` 都 completed；child 真實 user／assistant turn 匹配；parent 收到通知後嘅回覆仍喺同一 turn `7306aff3-2fe1-4741-b32b-5a825982f230`。唔用 user prompt 含 marker 作成功判斷。
- 證據：`.test-output/orchestration-reload-proof.json`、`orchestration-reload-final-timeline.json`、`orchestration-reload-child-timeline.json`。最終 parent／child idle；另外兩個 Droid 測試 agents 因 plugin reload 而 closed；全部 activeTurn=null、pending permissions=0。

## 0.2.3 model multiplier／Usage

- Model label 直接使用 live Droid catalog `tokenMultiplier`；Desktop picker 同 selected trigger 已見 `GPT-6.1 Sol · 0.8×`、`GPT-6 Astra · 4×`、`GPT-6 Luna · 0.04×`。未知 multiplier 保留原名，未硬編 pricing。
- 實際 native `getContextStats()` no-model probe 成功，回報 estimated occupancy 同 model limit；唔用累計 tokenUsage 當 context。經 Paseo 發送 `USAGE_CHECK_OK` 測試 prompt 後，Desktop meter 顯示 `3% used · 29k / 922k tokens`。
- 首次 reload 曾因 host 太遲 subscribe 而漏咗 early usage。Installed adapter probe 確認：早到 usage 有 cache，但 subscribe 唔 replay；late idle usage 則正常。插件已喺 ready 後以 250／1000／3000ms 限次重發最新 snapshot，無額外 native RPC，close 取消 timers，host 只會替換 lastUsage，唔會重複累加 tokens。呢個係限次補償，唔係 host subscription ACK；如果 host 初始化超出重發期，仍要等下一次有效 usage update。
- 最終 plugin／agent reload 後，未再發 prompt 已取得 `contextWindowUsedTokens=27914`／`contextWindowMaxTokens=922000`，Desktop 顯示 3%；model 暫時切換到 Luna 再還原 Sol，label 同 context refresh 正常，無新 model turn。
- Read-only Factory `/api/billing/limits` probe、正式 source adapter、installed Paseo global Usage 都成功。取得 Standard used 3／39／37%、Core used 0／0／22%，API reset 日期正常；Extra Usage USD balance 為 0。呢啲係 2026-10-17 實測瞬間值，唔係固定套餐資料。
- Desktop Usage modal 真實顯示 Factory card、六個 window、reset countdown 同 Extra Usage 餘額；另有 Standard remaining 97／61／63%、Core remaining 100／100／78%，毋須改全域顯示偏好。未更改帳戶／套餐／overage 設定，未 refresh 或寫入 credentials；只讀現有 macOS Keychain login。
- 證據：`.test-output/factory-quota-readonly.json`、`usage-source-live.json`、`paseo-usage-live.json`、`context-meter-reload-live.json`、`context-meter-model-change-live.json`；Desktop AX／screenshots 已喺 Computer Use 輸出檢視。
- 已確認 host 限制：generic `PluginAgentSession` 缺 `usageSession()`，agent-scoped `listUsageReports` 會喺呼叫 source 前返回空陣列；全域 Usage 正常。Installed registry probe 亦確認 sessionDiscoverCalls=0／globalDiscoverCalls=1。暫未修改 Paseo core，所以 Factory account quota 喺全域 Usage 查看，context meter 喺對話查看。

## 0.2.4 session 開啟前自動刷新 catalog

- 移除成功 catalog 嘅永久 cache；只保留相同 cwd／env 嘅 in-flight query，共用完成或失敗後都 retire。每次新 session、reload／resume 都重新讀取，並透過 `session.config` 發佈最新 models／multipliers。
- Session catalog query 帶入該 session env override，同 native launch 保持一致。並行不同 account 唔共用結果。單一 session close 只中止自己等待，唔會取消其他 waiter；selected model 已下架／禁用時，喺 native create／resume 前回報錯誤。
- 新增 7 個 deterministic regressions：同 cwd sequential multiplier／model 更新、resume freshness、picker／open overlap、不同 env、失敗重試同既有 session 隔離、移除 model、shared discovery 中取消一個 waiter。
- 真實 CLI／SDK probe：先查 picker，再建立兩個同 cwd sessions，再 resume 第一個，discovery 次數依次為 1／2／3／4；每次取得 67 models，兩次 create 同一次 resume，冇 model turns。每次 listModels 約 2.0–2.8 秒。
- 原始證據：`.test-output/catalog-refresh-native-smoke.json`、`catalog-refresh-tests.tap`、`final-unit-tests.tap`。
- Installed Paseo 0.11.4 新建無 prompt 嘅測試 agent `2f9fe9dc-be4d-4172-a28d-1fd5c58629be`，約 3.38 秒完成；再 reload 同一 agent 成功，timeline 仍為 0、activeTurn=null、pending permissions=0。Desktop AX／screenshot 核對 `GPT-6.1 Sol · 0.8×`、空對話同 1% context meter。證據：`.test-output/paseo-catalog-refresh-live.json`。
- 測試完成後已 archive 今次建立嘅空 test workspace／agent，未刪除 project directory；原有開發 workspace 同早前測試 agents 保留。
- Draft selector 仍受 host snapshot cache 影響；啟動前 freshness 保證唔等於未按 Create 前已更新 picker。Explicit Refresh providers 而家可以穿透插件 cache，running session 嘅既有 config 唔會自動被其他 session 更新。

## 0.2.5 正式名稱（2026-10-18）

- Manifest、provider label、README 同 OVERVIEW 統一使用 `Droid Native`，package／lockfile root version 更新到 0.2.5。Plugin／provider ID `droid-native`、registry ID `sunnypsk/droid` 同原有 dependencies 不變。
- Typecheck 同全部 109 個 tests 通過；無新增 model turn，亦無改動 provider lifecycle、permissions、steering 或 persistence 邏輯。
- 確認本機 Droid agents 均為 idle／closed 後 reload plugin。Desktop-managed Paseo 0.11.4 回報 plugin `running`，display name 為 `Droid Native`；未重啟 daemon。
- 本輪 native Computer Use 無法穩定開啟 Settings，之後回報 `noWindowsAvailable`；因此本輪只確認 daemon 回報嘅名稱，未宣稱完成新版 selector 嘅視覺驗證。先前功能實測仍屬上面各版本嘅證據。

## 證據邊界同已知限制

Paseo 0.11.4 嘅即時 user row 會保留附件預覽，但 agent reload 重建 timeline 後，原本圖片／文件 cards 會消失，只保留文字。今次已實際觀察到；Droid context 仍保留附件。插件未補上 host 附件 history rendering。

Pending 工具／plan approval 仍須先明確處理，Droid 無公開 deny-and-continue outcome；但 0.2.2 唔再自動中斷／替換原 turn。如果 approval 喺 ACK 途中才出現，已送達嘅 steering 會保留，並提示先處理 approval。

舊 fallback source 證據為 installed `app.asar` 內 `node_modules/@getpaseo/server/dist/server/server/agent/plugin-provider.js:923`（非 matching steer → unavailable）、`agent-manager.js:1835`／`:1908`（replacement）。0.2.2 改用 rejected acceptance，已經透過實際 plugin subprocess 喺 UI 驗證；未修改 host。

Native retraction 只做 source 檢查，未有真實 model retry/retraction 嘅完整 UI 證據。Host 會丟棄空文字 snapshot，native retraction 未保證清走已顯示文字。

亦嘗試過獨立 Chrome client `app.paseo.sh` 直連本機 daemon，結果 connection timeout。無改動 daemon web UI 設定或重啟 daemon。今次 UI 證據限 macOS Desktop 現有深色畫面；compact／手機 layout、實體裝置、daemon restart、長對話同 Mission mode 未驗證。ZIP／Office 等本機參考有 automated tests，未做 real model 解碼。

MCP 注入同 tool-policy mapping 已實作，exact preapproval 有 automated tests；真實 Paseo MCP create／send／automatic notifications 已經雙向驗證。其他外部 MCP services 未逐一測試。

測試 agent 保留喺同一 workspace，方便手動查看；測試檔案放喺 git-ignored `.test-output/`。
