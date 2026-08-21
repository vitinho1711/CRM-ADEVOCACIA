@echo off
chcp 65001 > nul
title Enviar CRM para o GitHub

echo ======================================================
echo    🚀 ENVIANDO PROJETO PARA O GITHUB
echo    Repositório: vitinho1711/CRM-ADEVOCACIA
echo ======================================================
echo.

cd /d "C:\Users\vitor\Documents\automação adevocacia"
"C:\Users\vitor\AppData\Local\MinGit\cmd\git.exe" push -u origin main

echo.
if "%ERRORLEVEL%"=="0" (
    echo ======================================================
    echo    ✅ ARQUIVOS ENVIADOS COM SUCESSO AO GITHUB!
    echo ======================================================
) else (
    echo [!] Se solicitou login, faca login na janela do navegador.
)

echo.
echo Pressione qualquer tecla para fechar esta janela...
pause > nul
