# youtube-audio-downloader-extension

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)
![Release](https://img.shields.io/github/v/release/m-kunori-24/youtube-audio-downloader-extension)

YouTubeから音声をダウンロードするChrome拡張機能。Manifest V3に対応している。
YouTube動画ダウンロード幇助はポリシー上禁止されているため、Chromeウェブストアには公開していない。

## 主な機能
- **Popup UI**: ツールバーアイコンから開き、音声形式選択(mp3 / aac / m4a / opus / vorbis / wav / flac)と3段階の音質選択(標準 / 高音質 / 最高音質)を行える。ダウンロード中・変換中両方の進捗表示にも対応する。「参照...」ボタンで保存先フォルダを選択でき、選択済みフォルダ名も表示される。
- **多言語対応**: Chromeのブラウザ言語設定に応じて日本語・英語が自動で切り替わる。
- **外部依存なし**: Python・yt-dlp・ffmpegなど外部ソフトウェアは一切必要ない。

## 必要な環境
- Chrome、Brave等のChromium系ブラウザ
- YouTubeにログインしていること(拡張機能を使用するブラウザプロファイル内でのログインが必須)

## インストール
1. [Releasesページ](https://github.com/m-kunori-24/youtube-audio-downloader-extension/releases/latest)から最新のzipをダウンロードする。
2. Chromeで `chrome://extensions` を開く。
3. 右上の「デベロッパーモード」をONにする。
4. ダウンロードしたzipを `chrome://extensions` のページにドラッグ&ドロップする。
5. 読み込み後は、ツールバーの拡張機能アイコンから利用できる。

アンインストールする場合は `chrome://extensions` から手動で削除する。

## 使い方
YouTubeのタブが開いている状態で、ツールバーの拡張機能アイコンをクリックするとPopup UIが開く。

- 「音声形式」で mp3 / aac / m4a / opus / vorbis / wav / flac を選択できる。
- 「音質」で標準 / 高音質 / 最高音質を選択できる。wav・flacは常に標準となる。
- 「保存先」の「参照...」で保存先フォルダを選択できる。未選択の場合はDownloadsフォルダへ保存される。フォルダ選択に対応していないブラウザ(Braveなど)では参照ボタンが無効化され、Downloadsフォルダへ保存される旨の注記が表示される。
- 「ダウンロード開始」をクリックすると、ダウンロード中・変換中それぞれの進捗が表示される。

ダウンロードが完了または失敗するとブラウザ通知が表示される。

## ライセンス
本プロジェクト自体はMIT License。詳細は[LICENSE](LICENSE)を参照。
本拡張機能は以下のMIT licensed librariesをバンドルしている:
- mediabunny (Webコーデック)
- wasm-media-encoders (LAME MP3, FLAC, Vorbis encoders)

---

# youtube-audio-downloader-extension (English)

A Chrome extension (Manifest V3) that downloads audio from YouTube videos.
It is not published on the Chrome Web Store, since aiding YouTube video
downloads is against the platform's policies.

## Features
- **Popup UI**: opened from the toolbar icon. Choose an audio format (mp3 / aac / m4a / opus / vorbis / wav / flac) and one of three quality tiers (standard / high / best). Shows progress during both downloading and converting. The "Browse..." button lets you pick a save folder, and the selected folder name is displayed.
- **Multi-language UI**: automatically switches between Japanese and English based on Chrome's browser language setting.
- **No external dependencies**: no Python, yt-dlp, or ffmpeg required.

## Requirements
- A Chromium-based browser (Chrome, Brave, etc.)
- You must be logged into YouTube in the browser profile the extension runs in.

## Installation
1. Download the latest zip from the [Releases page](https://github.com/m-kunori-24/youtube-audio-downloader-extension/releases/latest).
2. Open `chrome://extensions` in Chrome.
3. Turn on "Developer mode" in the top right corner.
4. Drag the downloaded zip onto the `chrome://extensions` page.
5. Once loaded, the extension is available from its toolbar icon.

To uninstall, remove it manually from `chrome://extensions`.

## Usage
With a YouTube tab open, click the toolbar icon to open the popup.

- Choose an audio format: mp3 / aac / m4a / opus / vorbis / wav / flac.
- Choose a quality tier: standard / high / best. wav and flac always use standard.
- Click "Browse..." next to "Save location" to pick a save folder; if none is selected, files are saved to the Downloads folder. In browsers that don't support folder selection (e.g. Brave), the Browse button is disabled and a notice explains that files will be saved to the Downloads folder.
- Click "Start download" to begin; progress for both the download and conversion phases is shown in the popup.

A browser notification is shown when a download completes or fails.

## License
This project itself is licensed under the MIT License — see [LICENSE](LICENSE) for details.
This extension bundles the following MIT-licensed libraries:
- mediabunny (web codecs)
- wasm-media-encoders (LAME MP3, FLAC, Vorbis encoders)
