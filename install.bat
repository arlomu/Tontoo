@echo off

:: Check for administrator rights
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo You need to run this script as Administrator!
    pause
    exit /b 1
)

echo Installing Tontoo...

:: Function to install missing software
:install_if_missing
set cmd=%1
set pkg=%2

where %cmd% >nul 2>&1
if %errorLevel% neq 0 (
    echo 12%% | [#####]
    apt update && apt install -y %pkg%
) else (
    echo Error
)

call :install_if_missing node nodejs
call :install_if_missing npm npm
call :install_if_missing git git

if exist "Tontoo" (
    echo 32%% [#######]
    rmdir /s /q Tontoo
)

git clone https://github.com/arlomu/Tontoo || (echo Cloning Error & exit /b 1)

cd Tontoo\CLI || (echo Error & exit /b 1)

echo 54%% [########]
npm uninstall -g tontoo
npm install -g Tontoo-Code.tgz

cd ..\..

echo 75%% [#########]
rmdir /s /q Tontoo

echo Tontoo is Installed!
pause