FROM node:24.22.3-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY src/ src/
COPY server/ server/
COPY tools/profile.ts tools/profile.ts
COPY schema/ schema/
COPY examples/shop.toml examples/shop.toml
COPY integration/kinesis/verify.ts integration/kinesis/verify.ts
CMD ["node", "integration/kinesis/verify.ts"]
