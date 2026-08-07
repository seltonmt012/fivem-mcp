fx_version 'cerulean'
game 'gta5'
lua54 'yes'

author 'juliantsu'
description 'Convenience-store water shop: responsive NUI, server-authoritative purchasing'
version '1.0.0'

shared_script 'config.lua'

client_script 'client/main.lua'

server_scripts {
    'server/bridge.lua',
    'server/main.lua',
}

ui_page 'html/index.html'

files {
    'html/index.html',
    'html/style.css',
    'html/app.js',
}
