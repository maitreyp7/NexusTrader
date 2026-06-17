# Free RSS feeds grouped by sector
RSS_FEEDS = {
    "technology": [
        "https://feeds.finance.yahoo.com/rss/2.0/headline?s=AAPL,MSFT,GOOGL,META,AMZN&region=US&lang=en-US",
        "https://techcrunch.com/feed/",
        "https://www.theverge.com/rss/index.xml",
        "https://feeds.arstechnica.com/arstechnica/index",
        "https://www.wired.com/feed/rss",
    ],
    "defense": [
        "https://feeds.finance.yahoo.com/rss/2.0/headline?s=LMT,RTX,NOC,BA,GD&region=US&lang=en-US",
        "https://www.defensenews.com/arc/outboundfeeds/rss/",
        "https://breakingdefense.com/feed/",
    ],
    "energy": [
        "https://feeds.finance.yahoo.com/rss/2.0/headline?s=XOM,CVX,COP,SLB,OXY&region=US&lang=en-US",
        "https://oilprice.com/rss/main",
        "https://www.eia.gov/rss/todayinenergy.xml",
    ],
    "finance": [
        "https://feeds.finance.yahoo.com/rss/2.0/headline?s=JPM,BAC,GS,MS,WFC&region=US&lang=en-US",
        "https://www.federalreserve.gov/feeds/press_all.xml",
        "https://feeds.marketwatch.com/marketwatch/financialnews/",
    ],
    "rare_earth": [
        "https://feeds.finance.yahoo.com/rss/2.0/headline?s=MP,ALB,SQM,LAC&region=US&lang=en-US",
        "https://www.mining.com/feed/",
        "https://www.mining-technology.com/feed/",
    ],
    "healthcare": [
        "https://feeds.finance.yahoo.com/rss/2.0/headline?s=JNJ,PFE,UNH,ABBV,MRK&region=US&lang=en-US",
        "https://www.statnews.com/feed/",
        "https://www.fiercepharma.com/rss/xml",
        "https://www.biopharmadive.com/feeds/news/",
    ],
    "semiconductors": [
        "https://feeds.finance.yahoo.com/rss/2.0/headline?s=NVDA,AMD,INTC,AVGO,TSM&region=US&lang=en-US",
        "https://www.semiconductordigest.com/feed/",
        "https://semiengineering.com/feed/",
        "https://www.eetimes.com/feed/",
    ],
    "macro": [
        "https://feeds.marketwatch.com/marketwatch/topstories/",
        "https://www.ft.com/?format=rss",
        "https://feeds.reuters.com/reuters/businessNews",
        "https://feeds.simplecast.com/54nAGcIl",  # Planet Money
        "https://feeds.bloomberg.com/markets/news.rss",
        "https://www.wsj.com/xml/rss/3_7085.xml",
        "https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines",
    ],
}

# SEC EDGAR — tickers to monitor per sector
SEC_WATCHLIST = {
    "technology":     ["AAPL", "MSFT", "GOOGL", "META", "AMZN", "CRM", "ORCL", "UBER", "NFLX", "SPOT"],
    "defense":        ["LMT", "RTX", "NOC", "BA", "GD", "AXON", "KTOS", "HII", "LDOS", "SAIC"],
    "energy":         ["XOM", "CVX", "COP", "SLB", "OXY", "NEE", "FSLR", "ENPH", "BE", "PLUG"],
    "finance":        ["JPM", "BAC", "GS", "MS", "WFC", "BLK", "SCHW", "V", "MA", "PYPL"],
    "rare_earth":     ["MP", "ALB", "SQM", "LAC", "SGML", "UUUU"],
    "healthcare":     ["JNJ", "PFE", "UNH", "ABBV", "MRK", "MRNA", "ISRG", "LLY", "REGN", "VRTX"],
    "semiconductors": ["NVDA", "AMD", "INTC", "AVGO", "TSM", "AMAT", "ASML", "KLAC", "LRCX", "ARM", "MRVL", "SMCI"],
}

# Reddit communities to monitor (ordered by signal quality)
REDDIT_SUBS = [
    "SecurityAnalysis",      # Professional-grade deep dives — highest quality
    "investing",             # General long-term investing discussion
    "stocks",                # News + earnings discussion
    "StockMarket",           # Broad market news
    "Economics",             # Macro + policy
    "wallstreetbets",        # Sentiment / retail momentum signal
    "geopolitics",           # Geopolitical risk signals
    "Superstonk",            # Market structure / options flow
    "ValueInvesting",        # Fundamental analysis
    "ETFs",                  # Sector rotation signals
    "options",               # Derivatives sentiment
    "pennystocks",           # Small cap momentum (noisy but useful)
]
