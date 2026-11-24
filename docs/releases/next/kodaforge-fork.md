Переводит KodaForge с каталога на форк
`ainurminibaev/bb-plugin-kodaforge` (версия 0.7.100 = 0.7.0 автора и правки из
`FORK.md`). Настройки плагина переносятся; открытые вкладки и раскладка лежат в
браузере и не меняются. Если форк не поднялся, каталожная версия возвращается сама.

Новое: картинки, видео, аудио, PDF, docx, xlsx, pptx, csv, Markdown и SVG
открываются во вкладке KodaForge (у текстовых есть кнопка Source / Preview); в
дереве — «Open in Terminal» и пункты других плагинов; «Close all» закрывает файлы,
а не KodaForge; настройка «Separate tabs per project» (выключена).
Project Open 0.3.2 добавляет в дерево «Открыть в Finder»; BB предлагает его сам.
Выделение файла — после обновления обработчика на Mac (`plugins/project-open/README.ru.md`).

Проверка: `python3 scripts/plugin_fork.py check kodaforge`; в KodaForge
открываются картинка и `.md`.
