fx_version 'cerulean'
game 'gta5'

author 'fivem-mcp'
description 'Loader for the fivem-mcp dev bridge. The real client code lives on the server.'
version '0.1.0'

-- Static NUI shell. boot.js does nothing until an authorized client has been
-- handed the real bridge code by the server.
ui_page 'nui/index.html'

-- The ONLY script every client receives. It contains no tooling, just the
-- request/load plumbing.
client_script 'client/loader.lua'

-- Value marshalling used by both the client payload and the server eval
-- handler. No secrets, no tooling -- safe to ship.
shared_scripts {
    'shared/marshal.lua',
}

server_scripts {
    'config.lua',
    'server/main.lua',
    'server/eval.lua',
}

files {
    'nui/index.html',
    'nui/boot.js',
}

--[[
    DELIBERATELY ABSENT from files{} and from any *_script list:

        payload/client.lua   the real client code
        payload/nui.js       the real NUI bridge
        config.lua           only listed under server_scripts, never shipped
        bridge.token         the shared secret

    A file that appears in neither files{} nor a client_script is never sent to
    a client, while the server can still read it with LoadResourceFile. That is
    the entire mechanism -- adding any of these paths to files{} would silently
    hand the tooling and the token to every player on the server.

    mcp-server/scripts/check-resource.mjs enforces this.
]]
