from fastapi import FastAPI

app = FastAPI(title="APEX API")

@app.get("/")
async def root():
    return {"message": "APEX API is running"}
