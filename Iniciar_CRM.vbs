Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\vitor\Documents\automação adevocacia"
WshShell.Run "node src/server.js", 0, False
WScript.Sleep 2000
WshShell.Run "http://localhost:8000"
