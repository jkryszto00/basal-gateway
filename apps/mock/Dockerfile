# Mock basal server image, for trying the stack without a GPU (made-up answers). From the repository root:
#   docker build -f apps/mock/Dockerfile -t basal-mock .
FROM oven/bun:1.3.14-slim
WORKDIR /app
COPY apps/mock/src src
USER bun
EXPOSE 8000
CMD ["bun", "src/index.ts"]
