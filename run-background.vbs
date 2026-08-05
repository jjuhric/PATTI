Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = scriptDir
Do
  WshShell.Run """C:\nvm4w\nodejs\node.exe"" backend/server.js", 0, true
  WScript.Sleep 5000
Loop
