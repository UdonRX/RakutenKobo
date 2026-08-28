# Kobo Finder

iPhone Safari / PWA向けの楽天Kobo書籍検索アプリ。**v0.1.0**。

## 構成
- 依存パッケージなしの静的PWA
- Vercel Static Hosting
- Vercel Function: `api/kobo.js` **1個のみ**
- 楽天Kobo eBook Search API / Genre Search API
- PWA / iOS safe area 対応

## Vercel環境変数
Production / Preview / Development に以下を設定してください。

- `RAKUTEN_APPLICATION_ID`
- `RAKUTEN_ACCESS_KEY`

秘密値はフロントエンドへ含めません。

## 機能
- 人気：総合 / 丸善ジュンク堂 / トーハン / Koboレビュー、今週 / 今月 / 今年
- 新着
- 受賞作 + 候補作
- ジャンル（漫画は1カテゴリ、成人向け除外、小説ではラノベ除外）
- タイトル / キーワード / 著者 / 出版社 / ISBN検索
- 気になる本を端末内保存
- Kobo商品ページへの直リンク

## ランキングデータについて
初期版は公開ランキングの上位情報を最小限のローカルシードとして保持し、Kobo APIで電子書籍版を照合します。ランキング元の利用条件を尊重し、出典をUIに明記します。将来更新時も同じファイルを更新し、バージョン別ファイルは増やしません。

## 開発
依存パッケージやビルド工程はありません。静的ファイルをそのままVercelで配信します。
