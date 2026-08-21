@echo off
chcp 65001 > nul
title Parar Sistema - Glaucio Dias Advocacia

echo ======================================================
echo    🛑  DESLIGANDO SISTEMA - GLAUCIO DIAS ADVOCACIA
echo ======================================================
echo.
echo Encerrando processos do servidor e do robô...
taskkill /f /im node.exe 2>NUL

echo.
echo ======================================================
echo    ✅ SISTEMA DESLIGADO COM SUCESSO!
echo ======================================================
echo.
timeout /t 3 > nul
exit
