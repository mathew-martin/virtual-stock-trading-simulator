/**
 * Stock Data Fetcher Lambda Function
 *
 * This Lambda function fetches real-time stock prices from Alpha Vantage API
 * and caches them in DynamoDB to minimize API calls and reduce latency.
 *
 * Environment Variables Required:
 * - ALPHA_VANTAGE_API_KEY: API key for Alpha Vantage
 * - CACHE_TABLE_NAME: DynamoDB table name for caching (provided by teammate)
 * - CACHE_TTL: Cache time-to-live in seconds (default: 45)
 *
 * DynamoDB Table Schema (teammate creates this):
 * - Partition Key: symbol (String) - e.g., "AAPL"
 * - Sort Key: dataType (String) - e.g., "quote"
 * - Attributes: data (Map), ttl (Number), timestamp (Number)
 * - TTL enabled on 'ttl' attribute
 */

const AWS = require('aws-sdk');
const axios = require('axios');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const CACHE_TABLE = process.env.CACHE_TABLE_NAME || 'stock-price-cache';
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '45');
const API_KEY = process.env.ALPHA_VANTAGE_API_KEY;

// Default stock symbols to fetch if none provided
const DEFAULT_SYMBOLS = ['AAPL', 'MSFT', 'AMZN', 'NVDA', 'TSLA', 'META', 'GOOGL', 'BRK.B', 'JPM', 'JNJ'];

/**
 * Lambda Handler
 *
 * Event format:
 * {
 *   "queryStringParameters": {
 *     "symbols": "AAPL,MSFT,AMZN"  // Optional: comma-separated symbols
 *   }
 * }
 *
 * Or for scheduled CloudWatch Events:
 * {
 *   "symbols": ["AAPL", "MSFT", "AMZN"]
 * }
 */
exports.handler = async (event) => {
    console.log('Event received:', JSON.stringify(event, null, 2));

    try {
        // Parse symbols from event
        let symbols = DEFAULT_SYMBOLS;

        if (event.queryStringParameters && event.queryStringParameters.symbols) {
            // API Gateway request format
            symbols = event.queryStringParameters.symbols.split(',').map(s => s.trim().toUpperCase());
        } else if (event.symbols && Array.isArray(event.symbols)) {
            // CloudWatch scheduled event format
            symbols = event.symbols.map(s => s.trim().toUpperCase());
        }

        console.log(`Fetching quotes for symbols: ${symbols.join(', ')}`);

        // Fetch quotes for all symbols
        const quotes = await Promise.all(
            symbols.map(symbol => fetchQuoteWithCache(symbol))
        );

        // Filter out any failed fetches
        const successfulQuotes = quotes.filter(q => q !== null);

        console.log(`Successfully fetched ${successfulQuotes.length} out of ${symbols.length} quotes`);

        // Return response (for API Gateway)
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*', // CORS - Matthew will configure in API Gateway
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'GET,OPTIONS'
            },
            body: JSON.stringify({
                success: true,
                quotes: successfulQuotes,
                timestamp: new Date().toISOString(),
                cached: successfulQuotes.filter(q => q.cached).length,
                fresh: successfulQuotes.filter(q => !q.cached).length
            })
        };

    } catch (error) {
        console.error('Error in handler:', error);

        return {
            statusCode: 500,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({
                success: false,
                error: error.message,
                timestamp: new Date().toISOString()
            })
        };
    }
};

/**
 * Fetch stock quote with caching logic
 * Checks cache first, then fetches from API if needed
 */
async function fetchQuoteWithCache(symbol) {
    try {
        // Step 1: Check cache first
        const cached = await getFromCache(symbol);
        if (cached) {
            console.log(`Cache HIT for ${symbol}`);
            return {
                ...cached,
                cached: true
            };
        }

        console.log(`Cache MISS for ${symbol}`);

        // Step 2: Fetch from Alpha Vantage API
        const quote = await fetchFromAlphaVantage(symbol);

        if (!quote) {
            console.warn(`Failed to fetch quote for ${symbol}`);
            return null;
        }

        // Step 3: Save to cache for future requests
        await saveToCache(symbol, quote);

        return {
            ...quote,
            cached: false
        };

    } catch (error) {
        console.error(`Error fetching quote for ${symbol}:`, error);
        return null;
    }
}

/**
 * Get quote from DynamoDB cache
 * Returns null if not found or expired
 */
async function getFromCache(symbol) {
    try {
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format

        const params = {
            TableName: CACHE_TABLE,
            Key: {
                symbol: symbol,
                date: today
            }
        };

        const result = await dynamodb.get(params).promise();

        // Check if item exists and is not expired
        if (result.Item && result.Item.ttl > Math.floor(Date.now() / 1000)) {
            return result.Item.data;
        }

        return null;

    } catch (error) {
        console.error(`Error reading from cache for ${symbol}:`, error);
        return null;
    }
}

/**
 * Save quote to DynamoDB cache with TTL
 */
async function saveToCache(symbol, data) {
    try {
        const now = Math.floor(Date.now() / 1000);
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format

        const params = {
            TableName: CACHE_TABLE,
            Item: {
                symbol: symbol,
                date: today,
                data: data,
                ttl: now + CACHE_TTL,
                timestamp: now,
                updatedAt: new Date().toISOString()
            }
        };

        await dynamodb.put(params).promise();
        console.log(`Saved ${symbol} to cache with TTL: ${CACHE_TTL}s`);

    } catch (error) {
        console.error(`Error saving to cache for ${symbol}:`, error);
        // Don't throw - caching failure shouldn't break the request
    }
}

/**
 * Fetch stock quote from Alpha Vantage API
 *
 * Alpha Vantage Free Tier Limits:
 * - 5 API calls per minute
 * - 500 API calls per day
 *
 * API Documentation: https://www.alphavantage.co/documentation/
 */
async function fetchFromAlphaVantage(symbol) {
    try {
        if (!API_KEY) {
            throw new Error('ALPHA_VANTAGE_API_KEY not configured');
        }

        const url = `https://www.alphavantage.co/query`;
        const params = {
            function: 'GLOBAL_QUOTE',
            symbol: symbol,
            apikey: API_KEY
        };

        console.log(`Fetching ${symbol} from Alpha Vantage...`);

        const response = await axios.get(url, { params, timeout: 10000 });

        // Check for API errors
        if (response.data['Error Message']) {
            throw new Error(`API Error: ${response.data['Error Message']}`);
        }

        if (response.data['Note']) {
            // Rate limit hit
            console.warn(`API Rate limit: ${response.data['Note']}`);
            throw new Error('API rate limit exceeded');
        }

        const globalQuote = response.data['Global Quote'];

        if (!globalQuote || Object.keys(globalQuote).length === 0) {
            throw new Error(`No data returned for ${symbol}`);
        }

        // Parse and format the quote data
        const quote = {
            symbol: symbol,
            price: parseFloat(globalQuote['05. price']) || 0,
            change: parseFloat(globalQuote['09. change']) || 0,
            changePct: parseFloat(globalQuote['10. change percent']?.replace('%', '')) || 0,
            volume: parseInt(globalQuote['06. volume']) || 0,
            latestTradingDay: globalQuote['07. latest trading day'] || '',
            previousClose: parseFloat(globalQuote['08. previous close']) || 0,
            open: parseFloat(globalQuote['02. open']) || 0,
            high: parseFloat(globalQuote['03. high']) || 0,
            low: parseFloat(globalQuote['04. low']) || 0
        };

        console.log(`Successfully fetched ${symbol}: $${quote.price} (${quote.changePct > 0 ? '+' : ''}${quote.changePct}%)`);

        return quote;

    } catch (error) {
        console.error(`Error fetching from Alpha Vantage for ${symbol}:`, error.message);
        return null;
    }
}
