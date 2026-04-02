curl -fsSL https://claude.ai/install.sh | bash

claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp --scope user
claude mcp add chrome-devtools --scope user -- npx -y chrome-devtools-mcp

curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
