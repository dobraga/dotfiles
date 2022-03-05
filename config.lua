lvim.log.level = "warn"
lvim.format_on_save = true
lvim.colorscheme = "onedarker"

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

