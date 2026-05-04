FROM node:20-alpine

WORKDIR /app

# Enable corepack and install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install

COPY . .
RUN pnpm build

EXPOSE 3000
CMD ["pnpm", "start"]

 /c/Users/venkat/.ssh/id_ed25519
 ssh-add $env:venkat\.ssh\id_ed25519
