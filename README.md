# shimon

コーディングエージェントが、変更したUIの状態を再現し、自動検査とスクリーンショットをまとめて確認するための小さなCLIです。

shimonは見た目の良し悪しを判断しません。対象画面を開いて事実と画像を返し、最終判断はエージェントが行います。

## 導入

Node.js 22以上とChromiumが必要です。

```sh
npm install --save-dev @hayashiii/shimon
npx playwright install chromium
```

### piで使う

shimonをpiパッケージとして追加すると、`shimon_verify`ツールとshimonスキルが読み込まれます。

```sh
pi install git:github.com/hayashiii-ghub/shimon
npx playwright install chromium
```

`shimon_verify`へ起動済みの画面URLと今回の確認ケースを渡せば、プロジェクト側の設定ファイルなしで実行できます。自動検査の結果と、同じ状態で撮影した全スクリーンショットがpiへ返ります。`pass`だけで完了とせず、返された画像を`intent`と`review`に沿って確認してください。

`/shimon`ではChromiumを含む実行準備を確認できます。サーバーの自動起動、操作状態を作る`prepare(page)`、独自`checks`、再利用する設定が必要な場合だけ、後述の`shimon.config.mjs`と`.shimon/task.mjs`を使います。

piからURLを直接渡すゼロ設定実行では、証拠をOSの一時領域へ保存し、対象プロジェクトの作業ツリーを変更しません。

Chromiumは容量が大きいため、piパッケージの導入時には自動インストールしません。

## 基本設定

プロジェクトには、接続先、画面幅、開発サーバー、機密情報のマスクだけを置けます。恒久ケースがなければ`cases`は省略できます。

```js
// shimon.config.mjs
export default {
  target: { url: "http://127.0.0.1:4322/" },
  viewports: {
    desktop: { width: 1440, height: 900 },
    mobile: { width: 390, height: 844 },
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:4322/",
    reuseExisting: true,
    timeoutMs: 30_000,
  },
  screenshot: { mask: ["[data-sensitive]"] },
};
```

設定はNode.jsとして実行されます。信頼できるリポジトリでだけ使ってください。

## 今回の確認ケース

UIを変更したら、必要な状態だけを`.shimon/task.mjs`へ書きます。基本設定や恒久ケースはプロジェクト側で維持します。

```js
export default {
  cases: [
    {
      name: "menu-mobile",
      path: "/pricing",
      viewport: "mobile",
      intent: "モバイルの料金メニューを確認する",
      prepare: (page) =>
        page.getByRole("button", { name: "Menu" }).click(),
      checks: [
        {
          id: "menu-visible",
          description: "メニューが表示されている",
          evaluate: (page) =>
            page.getByRole("navigation").isVisible(),
        },
      ],
      review: [
        "情報の優先順位が分かる",
        "内容が欠けたり重なったりしていない",
      ],
    },
  ],
};
```

```sh
npx shimon verify --task .shimon/task.mjs --json
npx shimon verify --case menu-mobile --task .shimon/task.mjs --json
```

各ケースは新しいブラウザーコンテキストで実行されます。`path`は`/`から始まるプロジェクト内のパス、`viewport`は基本設定の名前または幅と高さです。

## 結果

shimonは同じ状態から次を返します。

- overflow
- console errorと未処理のページエラー
- failed request
- axeによるアクセシビリティ違反
- プロジェクト固有の`checks`
- マスク済みスクリーンショット
- `intent`と`review`

`pass`は自動検査の結果です。スクリーンショットが保存されると`visualReviewRequired`は`true`になります。成功表示後も返された全画像を確認してください。

終了コードは、自動検査通過が`0`、画面またはケースの失敗が`1`、設定・サーバー・ブラウザーなどの実行エラーが`2`です。

CLIまたはプロジェクト設定を使う場合、証拠は`.shimon/runs/<run-id>/`へ保存され、`.shimon/latest.json`が最新結果を指します。直近3回だけを保持します。

## 安全上の注意

- `checks.evidence`へトークン、個人情報、認証状態を入れない
- 画像へ残る機密要素は`screenshot.mask`へ追加する
- 対象URLと診断メッセージの秘密情報除去は補助であり、アプリケーション自身も秘密をログへ出さない
- shimonは自動インストール、サイト巡回、画像差分、デザイン採点を行わない

## 開発

```sh
bun install
npx playwright install chromium
bun test
bun run typecheck
bun run build
```
