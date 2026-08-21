@echo off
chcp 65001 > nul
title Glaucio Dias Advocacia - CRM & Automação WhatsApp

echo ======================================================
echo    ⚖️  GLAUCIO DIAS ADVOCACIA - CRM & WHATSAPP IA
echo ======================================================
echo.
echo [1/2] Iniciando o servidor do sistema...
cd /d "%~dp0"

tasklist /FI "IMAGENAME eq node.exe" 2>NUL | find /I /N "node.exe">NUL
if "%ERRORLEVEL%"=="0" (
    echo [OK] O servidor ja esta em execucao!
) else (
    start /B "" node src/server.js
    echo [OK] Servidor iniciado com sucesso!
)

echo.
echo [2/2] Abrindo o Painel do CRM no seu navegador...
timeout /t 2 /nobreak > nul
start http://localhost:8000

echo.
echo ======================================================
echo    ✅ SISTEMA PRONTO E RODANDO EM SEGUNDO PLANO!
echo    🌐 Painel aberto em: http://localhost:8000
echo ======================================================
echo.
echo Voce pode fechar esta janela a qualquer momento.
timeout /t 5 > nul
exit
