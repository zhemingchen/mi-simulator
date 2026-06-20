import { buildMaterialUsageWeights } from './raw-material-policy.js';

/**
 * 主数据加载
 */

export const CSV_DATASET_SPECS = [
  { key: 'products', fileName: 'products.csv', columns: ['id', 'name'] },
  { key: 'materials', fileName: 'materials.csv', columns: ['id', 'name', 'leadTimeDays'] },
  { key: 'bom', fileName: 'bom.csv', columns: ['productId', 'materialId', 'qty'] },
  {
    key: 'demandNotices',
    fileName: 'demand-notices.csv',
    columns: ['noticeDate', 'productId', 'productName', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11', 'm12'],
  },
  { key: 'safetyStock', fileName: 'safety-stock.csv', columns: ['scope', 'itemId', 'qty'] },
  { key: 'productionPolicy', fileName: 'production-policy.csv', columns: ['productId', 'minProductionQty', 'batchSize'] },
  { key: 'supplierPolicy', fileName: 'supplier-policy.csv', columns: ['delayProbability'] },
];

export async function loadMasterData(basePath = './data') {
  const files = [
    'products',
    'bom',
    'materials',
    'demand-notices',
    'safety-stock',
    'production-policy',
    'supplier-policy',
  ];
  const keys = [
    'products',
    'bom',
    'materials',
    'demandNotices',
    'safetyStock',
    'productionPolicy',
    'supplierPolicy',
  ];
  const result = {};

  await Promise.all(
    files.map(async (file, i) => {
      const res = await fetch(`${basePath}/${file}.json`);
      if (!res.ok) throw new Error(`无法加载 ${file}.json`);
      result[keys[i]] = await res.json();
    })
  );

  return result;
}

function normalizeCsvHeader(header) {
  return String(header ?? '')
    .replace(/^\uFEFF/, '')
    .trim();
}

export function parseCsvText(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  const src = String(text ?? '').replace(/^\uFEFF/, '');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    if (ch === '\r') continue;
    cell += ch;
  }

  row.push(cell);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

function rowsToObjects(rows, requiredColumns, fileName) {
  if (!rows.length) {
    throw new Error(`${fileName} 为空`);
  }
  const headers = rows[0].map(normalizeCsvHeader);
  for (const col of requiredColumns) {
    if (!headers.includes(col)) {
      throw new Error(`${fileName} 缺少列：${col}`);
    }
  }
  const objects = [];
  for (let i = 1; i < rows.length; i++) {
    const values = rows[i];
    if (!values.some((v) => String(v ?? '').trim() !== '')) continue;
    const obj = {};
    headers.forEach((header, idx) => {
      obj[header] = String(values[idx] ?? '').trim();
    });
    obj.__rowNum = i + 1;
    objects.push(obj);
  }
  return objects;
}

function parseNumberField(value, field, fileName, rowNum) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${fileName} 第 ${rowNum} 行字段 ${field} 不是有效数字`);
  }
  return n;
}

function parseProductsCsv(text) {
  const rows = rowsToObjects(parseCsvText(text), ['id', 'name'], 'products.csv');
  return rows.map((row) => ({
    id: parseNumberField(row.id, 'id', 'products.csv', row.__rowNum),
    name: row.name,
  }));
}

function parseMaterialsCsv(text) {
  const rows = rowsToObjects(parseCsvText(text), ['id', 'name', 'leadTimeDays'], 'materials.csv');
  return rows.map((row) => ({
    id: parseNumberField(row.id, 'id', 'materials.csv', row.__rowNum),
    name: row.name,
    leadTimeDays: parseNumberField(row.leadTimeDays, 'leadTimeDays', 'materials.csv', row.__rowNum),
  }));
}

function parseBomCsv(text) {
  const rows = rowsToObjects(parseCsvText(text), ['productId', 'materialId', 'qty'], 'bom.csv');
  return rows.map((row) => ({
    productId: parseNumberField(row.productId, 'productId', 'bom.csv', row.__rowNum),
    materialId: parseNumberField(row.materialId, 'materialId', 'bom.csv', row.__rowNum),
    qty: parseNumberField(row.qty, 'qty', 'bom.csv', row.__rowNum),
  }));
}

function parseDemandNoticesCsv(text) {
  const required = ['noticeDate', 'productId', 'productName'];
  for (let m = 1; m <= 12; m++) required.push(`m${m}`);
  const rows = rowsToObjects(parseCsvText(text), required, 'demand-notices.csv');
  return rows.map((row) => {
    const months = {};
    for (let m = 1; m <= 12; m++) {
      const key = `m${m}`;
      const value = row[key];
      if (value === '') continue;
      months[String(m)] = parseNumberField(value, key, 'demand-notices.csv', row.__rowNum);
    }
    return {
      noticeDate: row.noticeDate,
      productId: parseNumberField(row.productId, 'productId', 'demand-notices.csv', row.__rowNum),
      productName: row.productName,
      months,
    };
  });
}

function parseSafetyStockCsv(text) {
  const rows = rowsToObjects(parseCsvText(text), ['scope', 'itemId', 'qty'], 'safety-stock.csv');
  const safetyStock = { finishedGoods: {}, rawMaterials: {} };
  for (const row of rows) {
    const scope = row.scope;
    if (scope !== 'finishedGoods' && scope !== 'rawMaterials') {
      throw new Error(`safety-stock.csv 第 ${row.__rowNum} 行 scope 必须是 finishedGoods 或 rawMaterials`);
    }
    safetyStock[scope][String(parseNumberField(row.itemId, 'itemId', 'safety-stock.csv', row.__rowNum))] =
      parseNumberField(row.qty, 'qty', 'safety-stock.csv', row.__rowNum);
  }
  return safetyStock;
}

function parseProductionPolicyCsv(text) {
  const rows = rowsToObjects(
    parseCsvText(text),
    ['productId', 'minProductionQty', 'batchSize'],
    'production-policy.csv'
  );
  const byProduct = {};
  for (const row of rows) {
    byProduct[String(parseNumberField(row.productId, 'productId', 'production-policy.csv', row.__rowNum))] = {
      minProductionQty: parseNumberField(
        row.minProductionQty,
        'minProductionQty',
        'production-policy.csv',
        row.__rowNum
      ),
      batchSize: parseNumberField(row.batchSize, 'batchSize', 'production-policy.csv', row.__rowNum),
    };
  }
  return { byProduct };
}

function parseSupplierPolicyCsv(text) {
  const rows = rowsToObjects(parseCsvText(text), ['delayProbability'], 'supplier-policy.csv');
  if (!rows.length) {
    throw new Error('supplier-policy.csv 不能为空');
  }
  return {
    delayProbability: parseNumberField(
      rows[0].delayProbability,
      'delayProbability',
      'supplier-policy.csv',
      rows[0].__rowNum
    ),
  };
}

export function parseCsvMasterDataTexts(csvTexts) {
  return {
    products: parseProductsCsv(csvTexts.products),
    materials: parseMaterialsCsv(csvTexts.materials),
    bom: parseBomCsv(csvTexts.bom),
    demandNotices: parseDemandNoticesCsv(csvTexts.demandNotices),
    safetyStock: parseSafetyStockCsv(csvTexts.safetyStock),
    productionPolicy: parseProductionPolicyCsv(csvTexts.productionPolicy),
    supplierPolicy: parseSupplierPolicyCsv(csvTexts.supplierPolicy),
  };
}

export async function loadMasterDataFromCsvFiles(fileMap) {
  const csvTexts = {};
  for (const spec of CSV_DATASET_SPECS) {
    const file = fileMap?.[spec.key];
    if (!file) throw new Error(`缺少文件：${spec.fileName}`);
    csvTexts[spec.key] = await file.text();
  }
  return parseCsvMasterDataTexts(csvTexts);
}

/** 构建 BOM 索引：productId -> [{ materialId, qty }] */
export function buildBomIndex(bom) {
  const index = new Map();
  for (const row of bom) {
    if (!index.has(row.productId)) index.set(row.productId, []);
    index.get(row.productId).push({ materialId: row.materialId, qty: row.qty });
  }
  return index;
}

/** 构建物料索引 */
export function buildMaterialIndex(materials) {
  const index = new Map();
  for (const m of materials) index.set(m.id, m);
  return index;
}

/** 深拷贝安全库存配置 */
export const DEFAULT_FINISHED_GOODS_SS = 10;

export function cloneSafetyStock(safetyStock) {
  return {
    finishedGoods: { ...safetyStock.finishedGoods },
    rawMaterials: { ...safetyStock.rawMaterials },
  };
}

/** 为全部 SKU 填充默认成品 SS（未配置时使用 10） */
export function applyDefaultFinishedGoodsSafetyStock(safetyStock, productIds) {
  for (const id of productIds) {
    const key = String(id);
    const v = safetyStock.finishedGoods[key];
    if (v == null || v === 0) {
      safetyStock.finishedGoods[key] = DEFAULT_FINISHED_GOODS_SS;
    }
  }
}

/** 将任意来源的数据装配为仿真可直接使用的 master + safetyStock；后续 CSV 上传复用此入口 */
export function buildMasterDataBundle(data) {
  const bomIndex = buildBomIndex(data.bom);
  const productIds = data.products.map((p) => p.id);
  const safetyStock = cloneSafetyStock(data.safetyStock);
  applyDefaultFinishedGoodsSafetyStock(safetyStock, productIds);

  return {
    master: {
      ...data,
      bomIndex,
      materialIndex: buildMaterialIndex(data.materials),
      materialUsageWeights: buildMaterialUsageWeights(bomIndex, productIds),
    },
    safetyStock,
  };
}
