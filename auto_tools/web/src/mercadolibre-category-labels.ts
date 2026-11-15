const TOP_LEVEL_LABELS: Record<string, string> = {
  'Accesorios para Vehículos': '车辆配件',
  'Alimentos y Bebidas': '食品和饮料',
  'Animales y Mascotas': '宠物用品',
  'Antigüedades y Colecciones': '古董和收藏品',
  'Autos, Motos y Otros': '汽车、摩托车及其他',
  Bebés: '婴儿用品',
  'Belleza y Cuidado Personal': '美容与个人护理',
  'Cámaras y Accesorios': '相机及配件',
  'Celulares y Telefonía': '手机及通信',
  Computación: '电脑及办公设备',
  'Consolas y Videojuegos': '游戏机和电子游戏',
  Construcción: '建筑和建材',
  'Deportes y Fitness': '运动和健身',
  'Electrónica, Audio y Video': '电子产品、音频和视频',
  'Hogar, Muebles y Jardín': '家居、家具和园艺',
  'Industrias y Oficinas': '工业和办公用品',
  'Instrumentos Musicales': '乐器',
  'Joyas y Relojes': '珠宝和手表',
  'Juguetes y Niños': '玩具和儿童用品',
  'Libros, Revistas y Comics': '书籍、杂志和漫画',
  'Música, Películas y Series': '音乐、电影和影视',
  'Ropa, Bolsas y Calzado': '服装、箱包和鞋类',
  'Ropa y Accesorios': '服装和配件',
  'Ropa Infantil': '童装',
  'Ropa para Niños': '童装/男童',
  'Ropa para Niñas': '童装/女童',
  'Vestuario para Bebés': '婴幼儿服装',
  'Poleras y Polos': 'T恤/短袖和 Polo 衫',
  Poleras: 'T恤/短袖',
  Camisetas: 'T恤/短袖',
  'Manga Corta': '短袖',
  Niños: '童装/男童',
  Niñas: '童装/女童',
  Infantil: '儿童',
  'Salud y Equipamiento Médico': '健康和医疗设备',
  Servicios: '服务',
  Inmuebles: '房地产',
  'Entradas para Eventos': '活动门票',
  Otros: '其他',
};

/** 将 Mercado Libre 的常见西语类目路径转换为中文显示名；原始 ID/名称仍保留。 */
export function localizeMercadoLibreCategory(label: string): string | undefined {
  const parts = label.split(/\s*(?:>|\/)\s*/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return undefined;
  const localized = parts.map((part) => TOP_LEVEL_LABELS[part] || part).join(' / ');
  return localized !== label ? localized : undefined;
}
