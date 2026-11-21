[English](README.md) · **Русский**

# KodaForge: правки поверх каталожной версии

Три правки KodaForge (`kodaforge@bb-community`), которые Plugin Keeper
(`plugins/voice-mode-keeper/patch_keeper.py`) держит после его обновлений.
Исходники плагина не копируются, форка нет.

- `editor.patch` — `components/EditorGroup.tsx`: редактор не обводит рамками
  буквы, похожие на латинские (`unicodeHighlight.ambiguousCharacters`). В русском
  тексте рамка стояла почти на каждом слове. Правка только визуальная: рывки
  прокрутки, из-за которых она появилась, вызывали стили `machine-tabs`
  (см. «Производительность» в `docs/customizations.md`).
- `terminal.patch` — `components/TerminalPanel.tsx`: вывод терминала KodaForge
  получает опросом, в простое интервал рос до 400 мс, и эхо нажатия ждало
  следующего опроса. Теперь нажатие будит опрос и на 1,5 с держит интервал 30 мс.

- `tabs.patch` — `app.tsx`, `server.ts`: у вкладки и в списке проектов видны
  проект и машина (раньше вкладка, открытая по ссылке, называлась «Workspace»);
  кнопка «Close all»; после закрытия последней вкладки страница остаётся пустой,
  а не открывает первую папку из списка.

Проверка: `python3 plugins/voice-mode-keeper/patch_keeper.py kodaforge`
(состояние `ready`). Если новая версия KodaForge не принимает патч, она работает
как у автора, а статус Keeper просит внимания.

Все три правки отправлены автору: pull request
[#14](https://github.com/Kodaks94/bb-plugin-kodaforge/pull/14) (редактор),
[#15](https://github.com/Kodaks94/bb-plugin-kodaforge/pull/15) (терминал) и
[#16](https://github.com/Kodaks94/bb-plugin-kodaforge/pull/16) (вкладки). Когда
их примут, Keeper сам сообщит, что патч больше не нужен.

Поверх этих трёх правок Keeper применяет `workspace-close.patch`. Рабочая
область сохраняет объект scope при закрытии соседней вкладки, поэтому открытый
Monaco не начинает повторную загрузку. При закрытии активной вкладки сразу
показывается её сосед. Правый клик по вкладке предлагает Close others (оставить
именно эту вкладку) и Close all. Следующий патч, `workspace-close-menu.patch`,
оставляет Close all только в контекстном меню. Подтверждение учитывает только
закрываемые рабочие области.
