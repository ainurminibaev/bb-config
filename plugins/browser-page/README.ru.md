[English](README.md) · **Русский**

# Browser Page (id `browser-page`)

Навык для агентов BB там, где штатный Browser Automation не запускается: на
Windows DevBrowser отвечает «DevBrowser has no runtime for win32-x64». Плагин
даёт агенту открыть страницу во встроенном браузере BB, прочитать её, нажимать
элементы, вводить текст, выполнять JavaScript и сохранять снимки экрана.

Это навык и один скрипт без зависимостей `skills/browser-page/bb-page.mjs`. Он
использует только документированные команды BB (`bb browser create`, `acquire`,
`connection`, `release`, `close`). Вкладка работает в профиле браузера BB, то
есть с вашими входами на сайты.

Ограничения: одна вкладка на тред; запуск на машине, где открыто окно BB с
браузером; аренда управления — 30 минут, продлевается следующей командой; нет
загрузки и скачивания файлов, нет сценариев с несколькими вкладками. На macOS и
Linux лучше использовать Browser Automation.

Установка: входит в набор bb-config (`python3 scripts/updates.py apply`), отдельно —
`npm ci --prefix plugins/browser-page --include=dev`, затем
`bb plugin install path:<checkout>/plugins/browser-page --yes`.
Проверка в треде BB: `node skills/browser-page/bb-page.mjs open https://example.com`,
`… text`, `… close`.
