`bb browser-relay status` показывает, подключена ли служба к Chrome, а не только
отвечает ли она. `bb browser-relay connect` делает одну попытку подключения и ждёт
одно «Allow» до 10 минут без повторов. `stop --thread`/`--all` и `resume` останавливают
агента в браузере; список остановок общий с Mac Computer Use.

После обновления плагина один раз выполните на Mac с Chrome
`bb browser-relay service install --machine <Mac>`: служба перезапустится с долгим
ожиданием «Allow», затем `bb browser-relay connect` и одно нажатие «Allow».
Откат: тег v0.1.0.
