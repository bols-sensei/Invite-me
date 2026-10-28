import csv
import random

prenoms = ["Jean", "Paul", "Patrick", "Joseph", "Emmanuel", "Dieudonné", "Serge", "Didier", "Papy", "Christian",
           "Alain", "Blaise", "Cédric", "David", "Eric", "Fabrice", "Gaston", "Hervé", "Ivan", "Joël",
           "Kevin", "Luc", "Marc", "Nathan", "Olivier", "Pierre", "Quentin", "Roger", "Samuel", "Thierry",
           "Marie", "Jeanne", "Grâce", "Esther", "Nicole", "Christine", "Sylvie", "Bernadette", "Thérèse", "Alice",
           "Béatrice", "Céline", "Diane", "Elise", "Francine", "Gisèle", "Hélène", "Irène", "Joséphine", "Kavira"]

noms_famille = ["Mukendi", "Kabeya", "Ilunga", "Kasongo", "Mwamba", "Nsimba", "Tshibangu", "Kanku", "Mbuyi", "Lukusa",
                "Mutombo", "Ngoy", "Kalonji", "Mpiana", "Bakajika", "Cibangu", "Dikamba", "Ekofo", "Fwamba", "Gbolo",
                "Hangi", "Ibenge", "Juma", "Kabasele", "Lumbala", "Mabika", "Ndaya", "Okitundu", "Panda", "Quenum"]

types = ["individuelle", "couple", "groupe"]

rows = []
noms_utilises = set()

def nom_unique(base):
    """Ajoute un suffixe numérique si le nom existe déjà."""
    if base not in noms_utilises:
        noms_utilises.add(base)
        return base
    i = 2
    while f"{base} {i}" in noms_utilises:
        i += 1
    nouveau = f"{base} {i}"
    noms_utilises.add(nouveau)
    return nouveau

while len(rows) < 500:
    type_ = random.choice(types)

    if type_ == "individuelle":
        nom = f"{random.choice(prenoms)} {random.choice(noms_famille)}"
        nombre = 1
    elif type_ == "couple":
        p1, p2 = random.sample(prenoms, 2)
        nom = f"{p1} et {p2} {random.choice(noms_famille)}"
        nombre = 2
    else:
        nom = f"Famille {random.choice(noms_famille)}"
        nombre = random.randint(3, 8)

    nom = nom_unique(nom)
    table = f"Table {random.randint(1, 12)}"
    rows.append([nom, type_, nombre, table])

with open("dataset_500.csv", "w", newline="", encoding="utf-8") as f:
    writer = csv.writer(f)
    writer.writerow(["nom", "type", "nombre", "table"])
    writer.writerows(rows)

print(f"✅ Fichier généré : {len(rows)} lignes, {len(noms_utilises)} noms uniques.")