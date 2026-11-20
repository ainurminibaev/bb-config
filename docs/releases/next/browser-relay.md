Агенты на любой машине (в том числе Codex на серверах) работают в настоящем Chrome
пользователя через одно общее подключение: `bb browser-relay call <инструмент>`.
Chrome спрашивает «Allow remote debugging?» один раз после запуска, а не на каждого агента.

Плагин ставится из отдельного репозитория `bb-plugin-browser-relay` и сам ставит
службу на Mac (`bb browser-relay service install --machine <Mac>`). Прежняя служба
chrome-devtools-shared из bb-config (любая метка) переносится автоматически — Chrome
один раз спросит «Allow». Codex на том же Mac продолжает работать через MCP
`chrome-devtools`, указывающий на ту же службу.

Заменяет невыпущенный шаг `chrome-devtools-shared`.

На машине, где службы раньше не было, её ставят вручную одной командой —
шаг сам машину с Chrome не выбирает.
