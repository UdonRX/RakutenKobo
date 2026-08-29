# RakutenKobo / Kobo Finder

iPhone（iOS）のSafari / PWAで「読みたい本を素早く見つける」ことに特化した楽天Kobo電子書籍検索アプリです。

**Current version: v0.2.0**

## URL

- Production: https://rakuten-kobo.vercel.app
- Repository: https://github.com/UdonRX/RakutenKobo

## v0.2.0

### 1. 9賞の受賞・候補データを拡充

以下の9賞を収録しています。

- 本屋大賞
- 芥川賞
- 直木賞
- 山本周五郎賞
- 吉川英治文学賞
- 吉川英治文学新人賞
- 江戸川乱歩賞
- 日本推理作家協会賞
- 大藪春彦賞

`catalog.js` に公式・主催者発表を基準とした賞データを保持し、受賞画面では「賞 → 年」の順に絞り込みます。
歴代受賞作を広く収録し、公式に候補・ノミネートが公開されている賞は近年の候補作品も収録しています。

画面表示時にはタイトル・著者を楽天Kobo APIへ照合し、**Kobo電子書籍として見つかった作品だけ**を表示します。
未刊行の最終候補作などはデータに保持していても、Kobo版がなければ表示されません。

### 2. 人気ランキングの安全な更新方式

人気ランキングの外部データは、アクセス時に書店サイトを自動スクレイピングしません。

`catalog.js` の `RANKING_SNAPSHOTS` に、

- 情報源
- 調査 / 更新基準日
- 期間
- ジャンル
- 順位
- タイトル / 著者
- 出典URL

をスナップショットとして保持します。

現在の主な情報源:

- 丸善ジュンク堂書店
- トーハン
- 楽天Koboレビュー件数順（これはKobo APIからライブ取得）

外部ランキングは公開元の利用条件に従い、アプリ画面でも調査元と日付を明記します。
更新時は公開元を人が確認し、`catalog.js` の既存スナップショットを更新して1回だけデプロイします。

これにより、

- 公開サイトへの過剰アクセスを防ぐ
- HTML変更でアプリが壊れるのを防ぐ
- 出典と基準日を明確にする
- Vercel HobbyのFunction実行を増やさない

という構成にしています。

### 3. Kobo Genre Search APIによる正式ジャンルマッピング

ジャンル画面はキーワードだけで分類せず、楽天Kobo Genre Search APIを使って実際のジャンル階層から `koboGenreId` を動的に解決します。

- ルート: `101`
- 親ジャンル → 子ジャンルを最大1階層だけ探索
- 解決結果はVercel Functionのプロセス内でキャッシュ
- Genre Searchに一時的な障害がある場合のみ、設定済みキーワードへフォールバック

「小説」ではKoboジャンルツリーからライトノベル系ジャンルIDを識別し、ライトノベルを除外します。
成人向けジャンルもGenre Search APIのIDとテキスト判定の両方で除外します。

## 主要機能

- 人気
  - 総合
  - 情報源別
  - 今週 / 今月 / 今年
- 新着
- 9賞の受賞作・候補作
- ジャンル検索
- 小説からライトノベル除外
- 漫画は「漫画」1カテゴリ
- 成人向け作品は非表示
- タイトル / キーワード / 著者 / 出版社 / ISBN検索
- 関連順 / 新着順 / レビュー件数 / 評価 / 価格で並び替え
- 気になる本（LocalStorage）
- iOS safe area対応
- PWA

## API構成

Vercel Functionは **1個だけ**です。

```text
/api/kobo.js
```

同一Function内で `action` により処理を分岐します。

- `action=search` — Kobo電子書籍検索
- `action=genres` — Genre Search確認
- `action=resolve` — 賞・ランキング作品を最大12件まとめてKoboへ照合
- `action=health` — Rakuten Kobo API認証診断

賞・ランキングの複数タイトル照合は1つのFunction呼び出しにまとめ、楽天APIへ短時間に大量リクエストしないよう少数並列＋間隔を空けて処理します。

## Vercel環境変数

```text
RAKUTEN_APPLICATION_ID
RAKUTEN_ACCESS_KEY
```

必要に応じて:

```text
RAKUTEN_ALLOWED_ORIGIN=https://rakuten-kobo.vercel.app
```

Application ID / Access Keyはフロントエンドへ露出させません。

## 開発ルール

- このリポジトリはRakutenKobo専用。他プロジェクトのコードを混在させない。
- バージョンごとにファイルを複製しない。
- バージョンは既存コード内・`package.json`で更新する。
- Vercel Hobbyプラン内で動く構成を維持する。
- Serverless Functionを不要に増やさない。
- 1改善につき調査・修正・テストをまとめ、mainへの反映とProduction Deploymentを極力1回にする。
