lvim.log.level = "warn"
lvim.format_on_save = true
lvim.lint_on_save = true
lvim.colorscheme = "onedarker"
vim.lsp.automatic_servers_installation = true

lvim.leader = "space"
lvim.keys.normal_mode = {
  -- Abrir terminal
  ["<C-t>"] = ":ToggleTerm<cr>",

  -- Move current line / block with Alt-j/k a la vscode.
  ["<A-j>"] = ":m .+1<CR>==",
  ["<A-k>"] = ":m .-2<CR>==",

  -- Save, exit vim and quit tab
  ["<C-s>"] = ":w<cr>",
  ["<C-q>"] = ":q<cr>",
  ["q"] = ":bdelete<cr>",

  -- Open Telescope
  ["f"] = "<cmd> Telescope find_files<cr>",
  ["<C-f>"] = "<cmd>Telescope live_grep<cr>",

  -- Centered cursor
  ["<Down>"] = "jzz",
  ["<Up>"] = "kzz",

  -- Navigate buffers
  ["<Tab>"] = ":bnext<CR>",
  ["<S-Tab>"] = ":bprevious<CR>",

  ["<C-Up>"] = false,
  ["<C-Down>"] = false,

  -- Nvim tree
  ["<C-b>"] = ":NvimTreeToggle<CR>",
  ["b"] = ":NvimTreeFocus<CR>"
}

lvim.keys.visual_mode = {
  ["<A-Down>"] = ":move '<-2<CR>gv-gv",
  ["<A-Up>"] = ":move '>+1<CR>gv-gv",
}

lvim.keys.insert_mode = {
  ["<C-s>"] = "<C-o>:w<cr>",
}


lvim.keys.visual_mode = {
  -- Better indenting
  ["<"] = "<gv",
  [">"] = ">gv",
}

lvim.keys.visual_block_mode = {
  -- Move selected line / block of text in visual mode
  ["K"] = ":move '<-2<CR>gv-gv",
  ["J"] = ":move '>+1<CR>gv-gv",

  -- Move current line / block with Alt-j/k ala vscode.
  ["<A-j>"] = ":m '>+1<CR>gv-gv",
  ["<A-k>"] = ":m '<-2<CR>gv-gv",
}

vim.opt.mouse=""
vim.opt.autoindent=true
vim.opt.wildmenu=true
vim.opt.laststatus=2
vim.opt.confirm=true
vim.opt.showmode=true
vim.opt.relativenumber=true
vim.opt.colorcolumn="88"

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
  { command = "isort", filetypes = { "python" } },
}

local linters = require "lvim.lsp.null-ls.linters"
linters.setup {
  { command = "flake8", filetypes = { "python" } , args = {"--max-line-length", 88}},
  -- { command = "mypy", filetypes = { "python" } },
}

lvim.plugins = {
    { "folke/tokyonight.nvim" },
    {
      "npxbr/glow.nvim",
      ft = { "markdown" }
    },
    {
      "karb94/neoscroll.nvim",
      event = "WinScrolled",
      config = function()
          require('neoscroll').setup({
            -- All these keys will be mapped to their corresponding default scrolling animation
            mappings = { 'zt', 'zz', 'zb' },
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

