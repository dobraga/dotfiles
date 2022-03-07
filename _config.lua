lvim.log.level = "warn"
lvim.format_on_save = true
lvim.lint_on_save = true
lvim.colorscheme = "tokyonight"
vim.lsp.automatic_servers_installation = true

lvim.leader = "space"
lvim.keys.normal_mode = {
  -- Abrir terminal
  ["<C-t>"] = ":ToggleTerm<cr>",

  -- Mover linhas
  ["<A-Up>"] = ":m -2<cr>",
  ["<A-Down>"] = ":m +1<cr>",

  -- Save and Exit
  ["<C-s>"] = ":w<cr>",
  ["<C-q>"] = ":q<cr>",
  ["q"] = ":bdelete<cr>",

  ["f"] = "<cmd> Telescope find_files<cr>",

  -- Centered cursor
  ["<Down>"] = "jzz",
  ["<Up>"] = "kzz",

  -- Navigate buffers
  ["<Tab>"] = ":bnext<CR>",
  ["<S-Tab>"] = ":bprevious<CR>",

  ["<C-Up>"] = false,

  ["<C-b>"] = ":NvimTreeToggle<CR>",
  ["b"] = ":NvimTreeFocus<CR>"
}

lvim.keys.insert_mode = {
  ["<C-s>"] = "<C-o>:w<cr>",
}


vim.opt.mouse=""
vim.opt.autoindent=true
vim.opt.wildmenu=true
vim.opt.laststatus=2
vim.opt.confirm=true
vim.opt.showmode=true
vim.opt.relativenumber=true

lvim.builtin.dashboard.active = true
lvim.builtin.notify.active = true
lvim.builtin.terminal.active = true
lvim.builtin.nvimtree.setup.view.side = "left"
lvim.builtin.nvimtree.show_icons.git = 1

lvim.builtin.treesitter.ensure_installed = {
  "bash",
  "c",
  "javascript",
  "json",
  "lua",
  "python",
  "typescript",
  "tsx",
  "css",
  "rust",
  "java",
  "yaml",
}

lvim.builtin.treesitter.ignore_install = { "haskell" }
lvim.builtin.treesitter.highlight.enabled = true

local formatters = require "lvim.lsp.null-ls.formatters"
formatters.setup {
  { command = "black", filetypes = { "python" } },
}

local linters = require "lvim.lsp.null-ls.linters"
linters.setup({{exe = "flake8", filetypes = { "python" } }})



lvim.plugins = {
    { "folke/tokyonight.nvim" },
    {
      "npxbr/glow.nvim",
      ft = { "markdown" }
    },
    {
      "folke/todo-comments.nvim",
      event = "BufRead",
      config = function()
          require("todo-comments").setup()
      end,
    },
    {
      "rmagatti/goto-preview",
      config = function()
          require('goto-preview').setup {
            width = 120; -- Width of the floating window
            height = 25; -- Height of the floating window
            debug = false; -- Print debug information
            opacity = nil; -- 0-100 opacity level of the floating window where 100 is fully transparent.
            post_open_hook = nil; -- A function taking two arguments, a buffer and a window to be ran as a hook.
            vim.cmd("nnoremap gpd <cmd>lua require('goto-preview').goto_preview_definition()<CR>");
            vim.cmd("nnoremap gpi <cmd>lua require('goto-preview').goto_preview_implementation()<CR>");
            vim.cmd("nnoremap gP <cmd>lua require('goto-preview').close_all_win()<CR>")
          }
      end
    },
    {
      "karb94/neoscroll.nvim",
      event = "WinScrolled",
      config = function()
          require('neoscroll').setup({
            -- All these keys will be mapped to their corresponding default scrolling animation
            mappings = { '<C-u>', '<C-d>', '<C-b>', '<C-f>',
                         '<C-y>', '<C-e>', 'zt', 'zz', 'zb' },
            hide_cursor = true, -- Hide cursor while scrolling
            stop_eof = true, -- Stop at <EOF> when scrolling downwards
            use_local_scrolloff = false, -- Use the local scope of scrolloff instead of the global scope
            respect_scrolloff = false, -- Stop scrolling when the cursor reaches the scrolloff margin of the file
            cursor_scrolls_alone = true, -- The cursor will keep on scrolling even if the window cannot scroll further
            easing_function = nil, -- Default easing function
            pre_hook = nil, -- Function to run before the scrolling animation starts
            post_hook = nil, -- Function to run after the scrolling animation ends
          })
      end
    },
    { "lervag/vimtex" },
}


