fx_version 'cerulean'
game 'gta5'
lua54 'yes'

author 'juliantsu'
description 'Free-for-all deathmatch: lobby, arena, random spawns, loadout, K/D tracking, auto respawn and a NUI scoreboard'
version '1.0.0'

shared_scripts {
    'config.lua',
}

client_scripts {
    'client/main.lua',
}

server_scripts {
    'server/main.lua',
}

ui_page 'html/index.html'

files {
    'html/index.html',
    'html/style.css',
    'html/app.js',
}
