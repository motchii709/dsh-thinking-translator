# dsh-thinking-translator

DeepSeek Harness(DSH)用プラグイン: モデルの **thinking(reasoning)部分**を、
ストリーム途中で目標言語へ翻訳します。モデル自体の思考言語は変えず、
`llm/stream` seam で reasoning ブロックのテキストだけを差し替えます。

![concept](https://img.shields.io/badge/DSH-0.1.1--rc.2-blue)

## 特徴

- **Host側割り込み**: `ctx.on("llm/stream")` waterfall で全モデル呼び出しをラップ。
  ブラウザ拡張やDOMハックに依存しないため、履歴・投影・リプレイすべてで翻訳後テキストが一貫します。
- **エンジン自動切替**(デフォルト):
  - APIキー不要 → Google翻訳 公開エンドポイント(keyless)
  - `GROQ_API_KEY` があれば → Groq(`openai/gpt-oss-20b`)による高品質翻訳に自動アップグレード
- **2つのモード**:
  - `append`(既定): 元の思考をライブ表示しつつ、ブロック確定時に `【翻訳】` を追記
  - `replace`: 思考確定まで静かにバッファし、翻訳のみを出力
- **フェイルセーフ**: 翻訳失敗・タイムアウト時は元テキストをそのまま通過(モデル呼び出しは壊さない)
- **日本語スキップ**: 既に日本語(kana比率)の思考は翻訳せずスルー

## インストール

```bash
dsh plugin --profile web add dsh-thinking-translator
dsh web
```

## 設定(プロファイルの cordis.patch.yml)

```yaml
- id: thinking-translator
  name: dsh-thinking-translator
  config:
    targetLang: ja            # 目標言語
    engine: auto              # auto | google | groq
    apiKeyEnv: GROQ_API_KEY   # Groq利用時の鍵参照(.credentials.yaml refs / 環境変数)
    groqModel: openai/gpt-oss-20b
    mode: replace             # replace = 翻訳のみ表示(既定) / append = 原文ライブ+末尾に翻訳
    translationHeader: 【翻訳】
    minLength: 40             # この文字数未満の思考はスキップ
    timeoutMs: 20000
```

## Groqで高品質翻訳(オプション)

`GROQ_API_KEY` が解決できれば、キーレス翻訳より品質の高い Groq(`openai/gpt-oss-20b`)へ自動切替します。
キーの取得は https://console.groq.com 。設定は下記のいずれか(優先度順):

1. **`.credentials.yaml`**(ホットリロード・再起動不要。WebのModelsページと同じ場所):
   ```yaml
   # C:\Users\motch\.dsh\.credentials.yaml
   version: 1
   refs:
     GROQ_API_KEY: gsk_...
   ```
2. **`$DSH_HOME/.env`**(`C:\Users\motch\.dsh\.env`、起動時に環境へ読まれる):
   ```
   GROQ_API_KEY=gsk_...
   ```
3. **起動時環境変数**: `$env:GROQ_API_KEY="gsk_..."; dsh web`

設定後 `engine: auto`(既定)なら自動的にGroqが使われます。明示する場合は `engine: groq`。

## 仕組み

```
model stream ──▶ llm/stream waterfall ──▶ 本plugin ──▶ BlockAssembler(agent loop)
                          │
                          ├─ reasoning-delta … バッファしつつ原文ライブ転送(append時)
                          └─ block-end(reasoning) … 翻訳→追記delta→block内容も合成して差し替え
```

`reasoning` ブロックが閉じるタイミングで翻訳するため、思考完了から翻訳表示まで
エンジン応答時間(約1〜3秒)の遅延が発生します。翻訳は会話ストリームをブロックしますが、
タイムアウト(既定20秒)で必ず抜けます。

## 制限事項

- 翻訳はブロック単位のため、超長文思考では初回表示が遅くなります(将来: 文単位インクリメント翻訳)
- Google keyless エンドポイントは非公式であり、仕様変更・レート制限の可能性があります
- `usage` / `finish` チャンクのメタデータは翻訳の影響を受けません(token数は原文ベース)

## 対応バージョン

- DSH `0.1.1-rc.2`(web プロファイル、他プロファイルでも動作見込み)

## ライセンス

MIT
