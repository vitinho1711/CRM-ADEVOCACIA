const { spawn } = require('child_process');
const path = require('path');

const gitExe = 'C:\\Users\\vitor\\AppData\\Local\\MinGit\\cmd\\git.exe';
const cwd = 'C:\\Users\\vitor\\Documents\\automação adevocacia';

console.log('========================================================');
console.log('🚀 Enviando projeto para o GitHub: vitinho1711/CRM-ADEVOCACIA');
console.log('========================================================\n');

const child = spawn(gitExe, ['push', '-u', 'origin', 'main'], {
    cwd,
    stdio: 'inherit'
});

child.on('close', (code) => {
    if (code === 0) {
        console.log('\n========================================================');
        console.log('✅ ARQUIVOS ENVIADOS COM SUCESSO AO GITHUB!');
        console.log('========================================================');
    } else {
        console.log('\n[!] Código de saída:', code);
    }
});
