Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "taskkill /f /im node.exe", 0, True
MsgBox "O sistema do escritorio Glaucio Dias Advocacia foi pausado/desligado com sucesso!", 64, "Glaucio Dias Advocacia"
